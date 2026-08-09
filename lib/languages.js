/**
 * Server-side language registry for Geno.
 *
 * Core languages (always available): Arabic + English.
 * Any other Chatterbox/Whisper language is enabled only after STT detects it,
 * so TTS/STT APIs stay desk-ready without the browser choosing a language.
 */

const CORE_LANGS = ["ar", "en"];

/** Languages the local Chatterbox multilingual model can speak. */
const TTS_SUPPORTED = new Set([
  "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko",
  "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
]);

const NAME_TO_CODE = {
  english: "en", arabic: "ar", french: "fr", german: "de", spanish: "es",
  italian: "it", portuguese: "pt", russian: "ru", chinese: "zh", japanese: "ja",
  korean: "ko", hindi: "hi", hebrew: "he", dutch: "nl", turkish: "tr",
  swedish: "sv", norwegian: "no", danish: "da", finnish: "fi", greek: "el",
  polish: "pl", malay: "ms", swahili: "sw", ukrainian: "ru", // closest TTS voice
};

const enabled = new Set(CORE_LANGS);
/** Last language Whisper reported (process-wide; one reception desk). */
let lastDetected = "en";

function normalizeLang(code) {
  if (!code || typeof code !== "string") return null;
  const raw = code.trim().toLowerCase();
  if (!raw) return null;
  if (NAME_TO_CODE[raw]) return NAME_TO_CODE[raw];
  // "en-US" / "ar-EG" / "fr"
  const short = raw.slice(0, 2);
  if (TTS_SUPPORTED.has(short)) return short;
  if (NAME_TO_CODE[short]) return NAME_TO_CODE[short];
  return null;
}

function listCore() {
  return [...CORE_LANGS];
}

function listEnabled() {
  return [...enabled].sort();
}

function listSupported() {
  return [...TTS_SUPPORTED].sort();
}

function isCore(lang) {
  const n = normalizeLang(lang);
  return Boolean(n && CORE_LANGS.includes(n));
}

function isEnabled(lang) {
  const n = normalizeLang(lang);
  return Boolean(n && enabled.has(n));
}

function getLastDetected() {
  return lastDetected;
}

/**
 * Enable a language after STT (or an explicit API call). Returns null if unsupported.
 */
function enableLanguage(lang) {
  const n = normalizeLang(lang);
  if (!n || !TTS_SUPPORTED.has(n)) {
    return { ok: false, language: n, error: "unsupported language" };
  }
  const newlyEnabled = !enabled.has(n);
  enabled.add(n);
  lastDetected = n;
  return {
    ok: true,
    language: n,
    newlyEnabled,
    core: isCore(n),
    enabled: listEnabled(),
  };
}

/**
 * Pick TTS language_id for a reply. Script first, then last STT language,
 * then English — never invents a non-enabled language.
 */
function resolveTtsLanguage(text, hint) {
  const fromHint = normalizeLang(hint);
  if (/[\u0600-\u06FF]/.test(text || "")) return preferEnabled("ar");
  if (/[\u0400-\u04FF]/.test(text || "")) return preferEnabled("ru");
  if (/[\u3040-\u30FF]/.test(text || "")) return preferEnabled("ja");
  if (/[\uAC00-\uD7AF]/.test(text || "")) return preferEnabled("ko");
  if (/[\u4E00-\u9FFF]/.test(text || "")) return preferEnabled("zh");
  if (/[\u0590-\u05FF]/.test(text || "")) return preferEnabled("he");
  if (/[\u0370-\u03FF]/.test(text || "")) return preferEnabled("el");
  if (/[\u0900-\u097F]/.test(text || "")) return preferEnabled("hi");

  if (fromHint) return preferEnabled(fromHint);
  return preferEnabled(lastDetected || "en");
}

function preferEnabled(lang) {
  const n = normalizeLang(lang) || "en";
  if (enabled.has(n)) return n;
  // Not enabled yet — fall back to English (always core) rather than failing.
  return enabled.has("en") ? "en" : "ar";
}

/**
 * Notify the local TTS sidecar that a language should be available.
 * Non-fatal if the sidecar is down.
 */
async function ensureTtsLanguage(lang, ttsLocalUrl) {
  const n = normalizeLang(lang);
  if (!n || !ttsLocalUrl) return { ok: false };
  try {
    const res = await fetch(`${ttsLocalUrl.replace(/\/$/, "")}/ensure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: n }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: err.slice(0, 200) };
    }
    return { ok: true, ...(await res.json().catch(() => ({}))) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  CORE_LANGS,
  TTS_SUPPORTED,
  normalizeLang,
  listCore,
  listEnabled,
  listSupported,
  isCore,
  isEnabled,
  getLastDetected,
  enableLanguage,
  resolveTtsLanguage,
  ensureTtsLanguage,
};
