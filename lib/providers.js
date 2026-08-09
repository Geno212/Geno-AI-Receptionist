// Production provider layer for Geno.
//
// One place where LLM / STT / TTS backends are selected, so switching from a
// paid API to a free or self-hosted one is an .env change, not a code change.
//
// Chosen defaults (benchmarked 2026-07-29, see bench/README.md):
//   LLM  groq  llama-3.3-70b-versatile   10/10 cases, ~858ms median (3x faster
//                                        than the Cloudflare incumbent)
//   STT  groq  whisper-large-v3          free, ~700ms, ~10% WER on clean Arabic
//   TTS  elevenlabs                      still paid; the only layer not yet free.
//                                        Swap to a self-hosted MIT model
//                                        (NAMAA / Chatterbox) once a GPU exists.
//
// Every provider is fail-soft: on error it returns null / throws a tagged error
// so the caller can fall back rather than dropping the caller's turn.

const DEFAULTS = {
  llm: {
    groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", keyEnv: "GROQ_API_KEY" },
    cerebras: { baseUrl: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", keyEnv: "CEREBRAS_API_KEY" },
    gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", keyEnv: "GEMINI_API_KEY" },
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", keyEnv: "OPENROUTER_API_KEY" },
  },
};

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

class ProviderError extends Error {
  constructor(provider, message, status = null) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.status = status;
    this.isQuota = status === 429 || status === 402;
  }
}

// ---------------------------------------------------------------- LLM

/**
 * Call the configured LLM. Returns the assistant text, or null on failure
 * (callers already handle a null reply with a language-aware fallback).
 *
 * LLM_PROVIDER: groq | cerebras | gemini | openrouter | cloudflare
 */
async function callLLM(messages, { temperature = 0.35, maxTokens = 256, timeoutMs = 15000 } = {}) {
  const provider = env("LLM_PROVIDER", "groq").toLowerCase();

  if (provider === "cloudflare") return callCloudflare(messages, { temperature, maxTokens, timeoutMs });

  const cfg = DEFAULTS.llm[provider];
  if (!cfg) throw new ProviderError(provider, `unknown LLM_PROVIDER "${provider}"`);

  const apiKey = env(cfg.keyEnv) || env("LLM_API_KEY");
  if (!apiKey) throw new ProviderError(provider, `missing ${cfg.keyEnv}`);

  const baseUrl = env("LLM_BASE_URL", cfg.baseUrl);
  const model = env("LLM_MODEL", cfg.model);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(provider, `HTTP ${res.status}: ${detail}`, res.status);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function callCloudflare(messages, { temperature, maxTokens, timeoutMs }) {
  const acct = env("CF_ACCOUNT_ID");
  const token = env("CF_API_TOKEN");
  const model = env("CF_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  if (!acct || !token) throw new ProviderError("cloudflare", "missing CF_ACCOUNT_ID/CF_API_TOKEN");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${encodeURI(model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, temperature, max_tokens: maxTokens }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError("cloudflare", `HTTP ${res.status}: ${detail}`, res.status);
    }
    const data = await res.json();
    return data?.result?.response ?? data?.result?.output_text ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try the primary LLM, then each fallback in LLM_FALLBACKS (comma-separated).
 * Free tiers throttle without warning, so a receptionist that goes silent on a
 * 429 is a real outage. Returns { text, provider } or { text: null }.
 */
async function callLLMWithFallback(messages, opts = {}) {
  const primary = env("LLM_PROVIDER", "groq").toLowerCase();
  const chain = [primary, ...env("LLM_FALLBACKS", "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]
    .filter((p, i, arr) => arr.indexOf(p) === i);

  let lastErr = null;
  for (const provider of chain) {
    const saved = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = provider;
    try {
      const text = await callLLM(messages, opts);
      if (text) return { text, provider };
      lastErr = new ProviderError(provider, "empty response");
    } catch (e) {
      lastErr = e;
      console.error(`[llm] ${provider} failed: ${e.message}`);
    } finally {
      process.env.LLM_PROVIDER = saved;
    }
  }
  if (lastErr) console.error(`[llm] all providers failed; last: ${lastErr.message}`);
  return { text: null, provider: null, error: lastErr };
}

// ---------------------------------------------------------------- STT

/**
 * Transcribe an audio buffer via Groq's free Whisper endpoint.
 *
 * `language` is pinned (default "ar") because Whisper's auto-detection
 * flip-flops on short ar/en code-switched utterances, which is most of what a
 * receptionist hears. Pass null to let Whisper auto-detect.
 */
async function transcribe(audioBuffer, { filename = "audio.webm", language = "ar", timeoutMs = 20000 } = {}) {
  const provider = env("STT_PROVIDER", "groq").toLowerCase();
  if (provider !== "groq") throw new ProviderError(provider, `unsupported STT_PROVIDER "${provider}"`);

  const apiKey = env("GROQ_API_KEY");
  if (!apiKey) throw new ProviderError("groq", "missing GROQ_API_KEY");

  const model = env("STT_MODEL", "whisper-large-v3");
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  // verbose_json returns Whisper's detected language when we leave language unset.
  form.append("response_format", language ? "json" : "verbose_json");
  form.append("temperature", "0");
  if (language) form.append("language", language);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError("groq", `HTTP ${res.status}: ${detail}`, res.status);
    }
    const data = await res.json();
    return {
      text: (data?.text || "").trim(),
      model,
      language: data?.language || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- health

/** Reports which providers are configured. Used by GET /config. */
function providerStatus() {
  const llmProvider = env("LLM_PROVIDER", "groq").toLowerCase();
  const cfg = DEFAULTS.llm[llmProvider];
  return {
    llm: {
      provider: llmProvider,
      model: env("LLM_MODEL", cfg?.model || env("CF_MODEL")),
      configured: llmProvider === "cloudflare"
        ? Boolean(env("CF_ACCOUNT_ID") && env("CF_API_TOKEN"))
        : Boolean(env(cfg?.keyEnv || "") || env("LLM_API_KEY")),
      fallbacks: env("LLM_FALLBACKS", "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    stt: {
      provider: env("STT_PROVIDER", "groq"),
      model: env("STT_MODEL", "whisper-large-v3"),
      configured: Boolean(env("GROQ_API_KEY")),
      serverSide: env("STT_SERVER_SIDE", "1") === "1",
    },
    tts: {
      provider: env("TTS_PROVIDER", "elevenlabs"),
      configured: env("TTS_PROVIDER", "elevenlabs") === "elevenlabs"
        ? Boolean(env("ELEVENLABS_API_KEY"))
        : Boolean(env("AZURE_SPEECH_KEY")),
    },
  };
}

module.exports = { callLLM, callLLMWithFallback, transcribe, providerStatus, ProviderError };
