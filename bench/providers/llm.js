// LLM providers, all normalized to the OpenAI chat-completions shape.
//
// Scope: Egyptian Arabic + English only.
//
// Provider selection and quotas are taken from:
//   https://github.com/cheahjs/free-llm-api-resources
//
// Training-on-data is NOT a selection constraint for this project (explicit
// owner decision, 2026-07). Providers are therefore ranked purely on quota,
// latency and Arabic quality. `trainsOnData` is still recorded per provider as
// a factual note, since El Sewedy's legal/procurement side may later care even
// though engineering does not.

const { ProviderError, MissingCredentialsError, QuotaError, isQuotaStatus } = require("./interface");

const DEFAULT_PARAMS = Object.freeze({ temperature: 0.35, max_tokens: 256 });

/**
 * Generic OpenAI-compatible chat call. Groq, Cerebras and OpenRouter all speak
 * this dialect, so they differ only in base URL, key and model id.
 */
async function openAiCompatible({ providerName, baseUrl, apiKey, envVars, model, messages, params, extraHeaders = {} }) {
  if (!apiKey) throw new MissingCredentialsError(providerName, envVars);

  const body = { model, messages, ...DEFAULT_PARAMS, ...params };
  const started = Date.now();

  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ProviderError(providerName, `network error: ${e.message}`, { cause: e });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (isQuotaStatus(res.status)) {
      throw new QuotaError(providerName, detail.slice(0, 300), res.status);
    }
    throw new ProviderError(providerName, `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
  }

  const data = await res.json();
  const latencyMs = Date.now() - started;
  const text = data?.choices?.[0]?.message?.content ?? "";

  return {
    text,
    latencyMs,
    ttfbMs: latencyMs, // non-streaming; see note in interface.js
    meta: { provider: providerName, model, params: body, usage: data?.usage ?? null },
  };
}

const providers = {
  groq: {
    label: "Groq",
    // Llama 3.3 70B: strongest free-tier multilingual model with real Arabic
    // competence. 1,000 req/day free.
    defaultModel: "llama-3.3-70b-versatile",
    trainsOnData: false,
    quota: "1,000 req/day, 12k TPM (70B)",
    envVars: ["GROQ_API_KEY"],
    call: (o) =>
      openAiCompatible({
        ...o,
        providerName: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY,
        envVars: ["GROQ_API_KEY"],
      }),
  },

  cerebras: {
    label: "Cerebras",
    // Very high tokens/day and extremely low latency, which is the metric that
    // matters most for a voice agent.
    defaultModel: "gpt-oss-120b",
    trainsOnData: false,
    quota: "1M tokens/day, 5 RPM",
    envVars: ["CEREBRAS_API_KEY"],
    call: (o) =>
      openAiCompatible({
        ...o,
        providerName: "cerebras",
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: process.env.CEREBRAS_API_KEY,
        envVars: ["CEREBRAS_API_KEY"],
      }),
  },

  /**
   * Google AI Studio. Highest free quota of any provider (1,500 req/day on
   * 2.5 Flash, 15 RPM) and the strongest Arabic of the free tier. Speaks the
   * OpenAI dialect via its compatibility endpoint, so it needs no special case.
   *
   * Trains on inputs outside the UK/EEA/CH -- recorded, but not a blocker here.
   */
  gemini: {
    label: "Google AI Studio (Gemini)",
    defaultModel: "gemini-2.5-flash",
    trainsOnData: true,
    quota: "1,500 req/day, 15 RPM (2.5 Flash)",
    envVars: ["GEMINI_API_KEY"],
    call: (o) =>
      openAiCompatible({
        ...o,
        providerName: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      }),
  },

  openrouter: {
    label: "OpenRouter",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    trainsOnData: true,
    quota: "50 req/day (1,000 with $10 topup)",
    envVars: ["OPENROUTER_API_KEY"],
    call: (o) =>
      openAiCompatible({
        ...o,
        providerName: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        envVars: ["OPENROUTER_API_KEY"],
      }),
  },

  // The incumbent, kept as the A/B baseline. Not free at scale, and its weak
  // structured-output reliability is why server.js parses <tool> tags by regex.
  cloudflare: {
    label: "Cloudflare Workers AI (incumbent baseline)",
    defaultModel: process.env.CF_MODEL || "@cf/meta/llama-3-8b-instruct",
    trainsOnData: false,
    quota: "10,000 neurons/day",
    envVars: ["CF_ACCOUNT_ID", "CF_API_TOKEN"],
    requiresAllEnvVars: true, // account id AND token, not either
    async call({ model, messages, params }) {
      const acct = process.env.CF_ACCOUNT_ID;
      const token = process.env.CF_API_TOKEN;
      if (!acct || !token) throw new MissingCredentialsError("cloudflare", ["CF_ACCOUNT_ID", "CF_API_TOKEN"]);

      const body = { messages, ...DEFAULT_PARAMS, ...params };
      const started = Date.now();
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${encodeURI(model)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (isQuotaStatus(res.status)) throw new QuotaError("cloudflare", detail.slice(0, 300), res.status);
        throw new ProviderError("cloudflare", `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
      }

      const data = await res.json();
      const latencyMs = Date.now() - started;
      const text = data?.result?.response ?? data?.result?.output_text ?? "";
      return {
        text,
        latencyMs,
        ttfbMs: latencyMs,
        meta: { provider: "cloudflare", model, params: body, usage: null },
      };
    },
  },
};

/**
 * Providers whose credentials are present right now.
 *
 * Cloudflare needs BOTH its vars (account id + token); every other provider
 * lists alternative names for one key (e.g. GEMINI_API_KEY or GOOGLE_API_KEY),
 * so any one of them is enough.
 */
function available() {
  return Object.entries(providers)
    .filter(([, p]) =>
      p.requiresAllEnvVars
        ? p.envVars.every((v) => process.env[v])
        : p.envVars.some((v) => process.env[v])
    )
    .map(([k]) => k);
}

async function callLlm(providerKey, messages, { model, params = {} } = {}) {
  const p = providers[providerKey];
  if (!p) throw new Error(`unknown LLM provider "${providerKey}" (have: ${Object.keys(providers).join(", ")})`);
  return p.call({ model: model || p.defaultModel, messages, params });
}

module.exports = { providers, available, callLlm, DEFAULT_PARAMS };
