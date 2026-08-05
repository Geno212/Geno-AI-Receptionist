// STT providers + Arabic-aware WER scoring.
//
// Primary candidate: Cohere Transcribe Arabic (Apache 2.0, weights on HF).
// Reports 25.87 WER on Arabic vs Whisper large-v3's 36.86, covers Egyptian
// dialect and ar/en code-switching, and runs on consumer hardware.
//
// Baseline: the browser Web Speech API currently used in public/client.html.
// That one cannot be benchmarked from Node -- it only exists in Chrome -- so
// bench/web-stt.html collects its transcripts for the same clips and they get
// pasted in as a provider of type "manual". Comparing against it matters
// because it is what El Sewedy runs today.

const fs = require("fs");
const { ProviderError, MissingCredentialsError, QuotaError, isQuotaStatus } = require("./interface");

// --- Arabic-aware normalization --------------------------------------------
// Without this, WER is dominated by orthographic noise (hamza spelling, tatweel,
// diacritics) rather than actual recognition errors.

const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

function normalizeArabic(s) {
  return s
    .replace(ARABIC_DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")   // alef variants
    .replace(/ى/g, "ي")        // alef maqsura -> ya
    .replace(/ة/g, "ه")        // ta marbuta -> ha
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))  // extended arabic-indic
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)); // arabic-indic digits
}

/** Shared normalization before WER: strip punctuation, fold case, collapse space. */
function normalizeForWer(text) {
  return normalizeArabic(String(text || "").toLowerCase())
    .replace(/[.,!?;:"'()\[\]{}«»…،؟؛]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein over word arrays -> WER. */
function wordErrorRate(reference, hypothesis) {
  const ref = normalizeForWer(reference).split(" ").filter(Boolean);
  const hyp = normalizeForWer(hypothesis).split(" ").filter(Boolean);
  if (ref.length === 0) return { wer: hyp.length === 0 ? 0 : 1, ref: 0, hyp: hyp.length, edits: hyp.length };

  const d = Array.from({ length: ref.length + 1 }, (_, i) =>
    Array.from({ length: hyp.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  const edits = d[ref.length][hyp.length];
  return { wer: edits / ref.length, ref: ref.length, hyp: hyp.length, edits };
}

/**
 * Did the model preserve required domain terms? For a receptionist, getting
 * "El Sewedy" or a host's name wrong is far worse than a generic word error,
 * so keyword recall is tracked separately from WER.
 */
function keywordRecall(hypothesis, keywords = []) {
  if (!keywords.length) return { recall: 1, missed: [] };
  const hyp = normalizeForWer(hypothesis);
  const missed = keywords.filter((k) => !hyp.includes(normalizeForWer(k)));
  return { recall: (keywords.length - missed.length) / keywords.length, missed };
}

// --- providers --------------------------------------------------------------

const providers = {
  /**
   * Groq hosted Whisper large-v3 (and -turbo). Per
   * github.com/cheahjs/free-llm-api-resources this is free at 2,000 req/day and
   * 28,800 audio-seconds/day, which is far beyond a reception desk's volume.
   *
   * This is the pragmatic demo-path STT: Whisper's Arabic WER (~36.9) is worse
   * than Cohere Transcribe Arabic (~25.9), especially on Egyptian dialect, but
   * it needs NO GPU and costs nothing -- so the pipeline can run end-to-end
   * today and swap to Cohere/self-hosted once hardware exists.
   *
   * Whisper is MIT-licensed, so self-hosting this exact model later is also an
   * option if El Sewedy prefers keeping audio in-house.
   */
  groq: {
    label: "Groq Whisper large-v3 (hosted, free)",
    kind: "hosted",
    license: "MIT (model) / Groq free tier",
    envVars: ["GROQ_API_KEY"],
    defaultModel: "whisper-large-v3",
    async transcribe({ audioPath, model, params = {} }) {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new MissingCredentialsError("groq", ["GROQ_API_KEY"]);

      const audio = fs.readFileSync(audioPath);
      const form = new FormData();
      form.append("file", new Blob([audio]), audioPath.split(/[\\/]/).pop());
      form.append("model", model);
      form.append("response_format", "json");
      // Pin language to Arabic: auto-detection flip-flops on short ar/en
      // code-switched utterances, which is most of what a receptionist hears.
      if (!("language" in params)) form.append("language", "ar");
      // temperature=0 for determinism, so hosted-vs-local diffs are meaningful.
      if (!("temperature" in params)) form.append("temperature", "0");
      for (const [k, v] of Object.entries(params)) form.append(k, String(v));

      const started = Date.now();
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (isQuotaStatus(res.status)) throw new QuotaError("groq", detail.slice(0, 300), res.status);
        throw new ProviderError("groq", `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
      }

      const data = await res.json();
      return {
        text: data?.text ?? "",
        lang: "ar-EG",
        latencyMs: Date.now() - started,
        meta: { provider: "groq", model, params: { language: "ar", temperature: 0, ...params }, raw: data },
      };
    },
  },

  /**
   * Cohere hosted API (free tier, rate-limited). Same weights as the
   * self-hosted path, but Cohere applies its own decode defaults -- which is
   * precisely the hosted-vs-local divergence the golden set exists to measure.
   */
  cohere: {
    label: "Cohere Transcribe Arabic (hosted)",
    kind: "hosted",
    license: "Apache-2.0",
    envVars: ["COHERE_API_KEY"],
    defaultModel: "transcribe-arabic",
    async transcribe({ audioPath, model, params = {} }) {
      const key = process.env.COHERE_API_KEY;
      if (!key) throw new MissingCredentialsError("cohere", ["COHERE_API_KEY"]);

      const audio = fs.readFileSync(audioPath);
      const form = new FormData();
      form.append("file", new Blob([audio]), audioPath.split(/[\\/]/).pop());
      form.append("model", model);
      for (const [k, v] of Object.entries(params)) form.append(k, String(v));

      const started = Date.now();
      const res = await fetch("https://api.cohere.com/v2/transcribe", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (isQuotaStatus(res.status)) throw new QuotaError("cohere", detail.slice(0, 300), res.status);
        throw new ProviderError("cohere", `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
      }

      const data = await res.json();
      return {
        text: data?.text ?? data?.transcription ?? "",
        lang: "ar-EG",
        latencyMs: Date.now() - started,
        meta: { provider: "cohere", model, params, raw: data },
      };
    },
  },

  /**
   * Self-hosted Cohere Transcribe via a local inference server.
   * Not runnable on this machine (MX350 / 2GB VRAM is far too small for a 2B
   * model); wired up now so El Sewedy's GPU box is a config change later.
   * Set STT_LOCAL_URL to the local endpoint.
   */
  local: {
    label: "Cohere Transcribe Arabic (self-hosted)",
    kind: "local",
    license: "Apache-2.0",
    envVars: ["STT_LOCAL_URL"],
    defaultModel: "transcribe-arabic",
    async transcribe({ audioPath, model, params = {} }) {
      const base = process.env.STT_LOCAL_URL;
      if (!base) throw new MissingCredentialsError("local", ["STT_LOCAL_URL"]);

      const audio = fs.readFileSync(audioPath);
      const form = new FormData();
      form.append("file", new Blob([audio]), audioPath.split(/[\\/]/).pop());
      form.append("model", model);
      // Pin decode params explicitly: local defaults differ from hosted ones,
      // and that difference is a silent source of transcript drift.
      for (const [k, v] of Object.entries(params)) form.append(k, String(v));

      const started = Date.now();
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ProviderError("local", `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
      }
      const data = await res.json();
      return {
        text: data?.text ?? "",
        lang: "ar-EG",
        latencyMs: Date.now() - started,
        meta: { provider: "local", model, params, raw: data },
      };
    },
  },

  /**
   * The incumbent: browser Web Speech API. Transcripts are collected manually
   * via bench/web-stt.html and stored in bench/fixtures/web-speech-results.json.
   */
  webspeech: {
    label: "Browser Web Speech API (incumbent, manual capture)",
    kind: "manual",
    license: "n/a (Chrome built-in)",
    envVars: [],
    defaultModel: "webkitSpeechRecognition",
    async transcribe({ audioPath }) {
      const file = require("path").join(__dirname, "..", "fixtures", "web-speech-results.json");
      if (!fs.existsSync(file)) {
        throw new ProviderError("webspeech", "no captured results; open bench/web-stt.html in Chrome first");
      }
      const results = JSON.parse(fs.readFileSync(file, "utf8"));
      const id = audioPath.split(/[\\/]/).pop();
      if (!(id in results)) throw new ProviderError("webspeech", `no captured transcript for "${id}"`);
      return {
        text: results[id],
        lang: "ar-EG",
        latencyMs: -1, // not measurable offline
        meta: { provider: "webspeech", model: "webkitSpeechRecognition", params: {} },
      };
    },
  },
};

/** Providers with credentials present. `webspeech` has none by design (its
 *  transcripts are captured manually in Chrome), so it is never auto-selected. */
function available() {
  return Object.entries(providers)
    .filter(([, p]) => p.envVars.length > 0 && p.envVars.some((v) => process.env[v]))
    .map(([k]) => k);
}

async function transcribe(providerKey, opts) {
  const p = providers[providerKey];
  if (!p) throw new Error(`unknown STT provider "${providerKey}" (have: ${Object.keys(providers).join(", ")})`);
  return p.transcribe({ ...opts, model: opts.model || p.defaultModel });
}

module.exports = {
  providers, available, transcribe,
  wordErrorRate, keywordRecall, normalizeForWer, normalizeArabic,
};
