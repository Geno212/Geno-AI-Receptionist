/**
 * Whisper invents captions on silence / TTS echo (YouTube outros, random
 * Portuguese/Bible lines, etc.). Reject those before they hit chat, LLM, or
 * the language/TTS enable path.
 */

const PHRASES = [
  // English
  "thanks for watching",
  "thank you for watching",
  "thanks for listening",
  "thanks for tuning in",
  "please subscribe",
  "like and subscribe",
  "see you next time",
  "don't forget to subscribe",
  "amara.org",
  "www.youtube.com",
  // Russian / Ukrainian (silence ghosts — often a single word)
  "дякую за перегляд",
  "дякую",
  "спасибо за просмотр",
  "спасибо",
  "подписывайтесь",
  "повторити",
  "повторіть",
  "субтитры",
  "редактор субтитров",
  "продолжение следует",
  "субтитры сделал",
  // Arabic YouTube / video outros (echo of silence after Geno speaks)
  "مرحبا بكم في هذا الفيديو",
  "مرحباً بكم في هذا الفيديو",
  "اهلا بكم في هذا الفيديو",
  "أهلا بكم في هذا الفيديو",
  "شكرا للمشاهدة",
  "شكراً للمشاهدة",
  "لا تنسوا الاشتراك",
  "لا تنسى الاشتراك",
  "اشتركوا في القناة",
  "اشترك في القناة",
  "ترجمة نانسي",
  "الى اللقاء",
  "إلى اللقاء في فيديو",
  // Portuguese / Spanish caption ghosts
  "a palavra é da bíblia",
  "a palavra e da biblia",
  "bíblia de roma",
  "biblia de roma",
  "legendas pela comunidade",
  "inscreva-se no canal",
  "gracias por ver",
  "suscríbete",
  "subtitulos",
  "subtítulos",
];

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "") // Arabic diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} text
 * @param {{ language?: string|null, noSpeechProb?: number|null, avgLogprob?: number|null, pinnedLang?: string|null }} [meta]
 * @returns {{ spurious: boolean, reason?: string }}
 */
function classifyTranscript(text, meta = {}) {
  const raw = (text || "").trim();
  if (!raw) return { spurious: true, reason: "empty" };

  const n = normalize(raw);
  // Ultra-short non-ar/en utterances are almost always Whisper ghosts.
  if (n.length <= 12 && !/[\u0600-\u06FF]/.test(raw) && !/^[a-z0-9\s'.-]+$/i.test(raw)) {
    return { spurious: true, reason: "ultra_short_non_latin_ar" };
  }
  // Cyrillic-only short lines (дякую / повторити / etc.)
  if (/^[\u0400-\u04FF\s!?.,]+$/u.test(raw) && raw.length < 40) {
    return { spurious: true, reason: "cyrillic_ghost" };
  }
  for (const phrase of PHRASES) {
    if (n.includes(normalize(phrase))) {
      return { spurious: true, reason: `phrase:${phrase}` };
    }
  }

  // High "no speech" from verbose_json = almost certainly invented audio.
  if (typeof meta.noSpeechProb === "number" && meta.noSpeechProb >= 0.55) {
    return { spurious: true, reason: `no_speech_prob=${meta.noSpeechProb.toFixed(2)}` };
  }
  if (typeof meta.avgLogprob === "number" && meta.avgLogprob < -1.05 && raw.length < 80) {
    return { spurious: true, reason: `avg_logprob=${meta.avgLogprob.toFixed(2)}` };
  }

  const pinned = (meta.pinnedLang || "").toLowerCase().slice(0, 2);
  const arChars = (raw.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (raw.match(/[A-Za-z]/g) || []).length;
  // When the UI locks English, reject dominant-Arabic captions (and vice versa)
  // for short clips — typical Whisper language-bleed on silence.
  if (pinned === "en" && arChars > latinChars && raw.length < 80) {
    return { spurious: true, reason: "pinned_en_got_arabic" };
  }
  if (pinned === "ar" && latinChars > arChars * 2 && raw.length < 40 && !/\b(ok|yes|no|hi|hello)\b/i.test(raw)) {
    return { spurious: true, reason: "pinned_ar_got_latin" };
  }

  // Multilingual Whisper loves random short non-ar/en ghosts on silence.
  // Only apply when Whisper itself claims a non-core language (and UI didn't pin).
  if (!pinned) {
    const lang = (meta.language || "").toLowerCase().replace(/_.*/, "").slice(0, 2);
    const core = lang === "ar" || lang === "en" || lang === "";
    if (!core && raw.length < 60) {
      return { spurious: true, reason: `short_non_core_lang=${lang}` };
    }
  }

  return { spurious: false };
}

function isSpuriousTranscript(text, meta) {
  return classifyTranscript(text, meta).spurious;
}

module.exports = {
  classifyTranscript,
  isSpuriousTranscript,
  PHRASES,
};
