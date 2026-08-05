// LLM benchmark cases for the Geno receptionist.
//
// These are NOT generic prompts. Each one targets a failure mode that actually
// occurred with Cloudflare Workers AI and is defended against in the live
// system prompt (server.js ~line 577-668):
//
//   - premature tool emission before all fields are collected
//   - hallucinated placeholder data ("John Doe", "Unknown", "123456789")
//   - language drift (answering Egyptian Arabic in English, or mid-reply switching)
//   - leaking raw JSON / the words "tool"/"JSON" into spoken output
//   - repeating the greeting and the caller's name every turn
//   - reading raw db.json structure aloud instead of paraphrasing
//
// Scope: Egyptian Arabic (ar-EG) + English (en) only.

const AR = /[؀-ۿ]/;
const CJK = /[一-鿿぀-ゟ゠-ヿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

/** Extract <tool>{...}</tool> exactly the way server.js does. */
function extractTool(text) {
  const m = String(text || "").match(/<tool>([\s\S]*?)<\/tool>/);
  if (!m) return { found: false, tool: null, parseOk: false, spoken: String(text || "").trim() };
  const spoken = String(text).replace(m[0], "").trim();
  try {
    return { found: true, tool: JSON.parse(m[1].trim()), parseOk: true, spoken };
  } catch {
    return { found: true, tool: null, parseOk: false, spoken };
  }
}

/** Strip <think> blocks (DeepSeek/R1 style), mirroring server.js:708. */
function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Values that mean "the model did not actually have this information".
// The "?" / "N/A" family was found in the wild: with the language bug fixed,
// the incumbent started emitting check_meeting with literal "?" for every
// field it had not collected -- which would write junk meeting records.
const PLACEHOLDER_PATTERNS = [
  /john\s+doe/i, /jane\s+doe/i, /\bunknown\b/i, /123456789/,
  /\[.*?\]/,                         // [Name], [Company], [Phone], ...
  /example\.com/i, /غير معروف/,
  /^[\s?？._-]*$/,                    // "?", "??", "-", "...", "", "？"
  /^n\/?a$/i, /^none$/i, /^null$/i, /^tbd$/i, /^undefined$/i,
  /^(not\s+(provided|specified|given|available))$/i,
  /^(غير\s+محدد|لم\s+يذكر)$/,
];

// --- assertions -------------------------------------------------------------

const assertions = {
  /** Reply must be in Egyptian Arabic: has Arabic script, no CJK, and no
   *  stray English sentences (a few Latin tokens like "El Sewedy" are fine). */
  arabicReply: (out) => {
    const spoken = extractTool(out).spoken;
    if (!AR.test(spoken)) return { pass: false, why: "no Arabic script in reply" };
    if (CJK.test(spoken)) return { pass: false, why: "CJK leaked into an Arabic reply" };
    const latin = (spoken.match(LATIN_WORD) || []).length;
    if (latin > 6) return { pass: false, why: `language drift: ${latin} English words in an Arabic reply` };
    return { pass: true };
  },

  englishReply: (out) => {
    const spoken = extractTool(out).spoken;
    if (AR.test(spoken)) return { pass: false, why: "Arabic script leaked into an English reply" };
    if (CJK.test(spoken)) return { pass: false, why: "CJK leaked into an English reply" };
    if (!LATIN_WORD.test(spoken)) return { pass: false, why: "no English text in reply" };
    return { pass: true };
  },

  /** The critical one: model must NOT emit a tool call yet. */
  noToolCall: (out) => {
    const t = extractTool(out);
    return t.found
      ? { pass: false, why: `emitted a tool call prematurely: ${JSON.stringify(t.tool)?.slice(0, 160)}` }
      : { pass: true };
  },

  /** Must emit a well-formed tool of the given name with all required args
   *  non-empty and free of placeholder junk. */
  toolCall: (name, requiredArgs) => (out) => {
    const t = extractTool(out);
    if (!t.found) return { pass: false, why: `expected <tool>${name}</tool>, none emitted` };
    if (!t.parseOk) return { pass: false, why: "tool block present but JSON did not parse" };
    if (t.tool?.name !== name) return { pass: false, why: `wrong tool: got "${t.tool?.name}", want "${name}"` };
    const args = t.tool?.args || {};
    for (const k of requiredArgs) {
      const v = args[k];
      if (v === undefined || v === null || String(v).trim() === "") {
        return { pass: false, why: `missing required arg "${k}"` };
      }
      if (PLACEHOLDER_PATTERNS.some((re) => re.test(String(v)))) {
        return { pass: false, why: `hallucinated placeholder in "${k}": ${v}` };
      }
    }
    return { pass: true };
  },

  /** Spoken text must never contain raw JSON or meta words. */
  noJsonLeak: (out) => {
    const spoken = extractTool(out).spoken;
    if (/\{[^}]*"[^"]+"\s*:/.test(spoken)) return { pass: false, why: "raw JSON leaked into spoken reply" };
    if (/\b(tool format|here is the json|json)\b/i.test(spoken)) {
      return { pass: false, why: "meta word (tool/JSON) leaked into spoken reply" };
    }
    return { pass: true };
  },

  /** Brevity: prompt demands max 1-2 sentences. */
  brief: (maxChars) => (out) => {
    const spoken = extractTool(out).spoken;
    return spoken.length <= maxChars
      ? { pass: true }
      : { pass: false, why: `too long: ${spoken.length} chars > ${maxChars}` };
  },

  /** Must not re-greet mid-conversation. */
  noGreeting: (out) => {
    const spoken = extractTool(out).spoken;
    if (/\b(welcome to|hello, i am geno|i am geno)\b/i.test(spoken) || /(أهلا بك في|أنا جينو)/.test(spoken)) {
      return { pass: false, why: "repeated the greeting mid-conversation" };
    }
    return { pass: true };
  },

  /** Must actually contain the answer -- at least one expected token. */
  mentions: (tokens, label) => (out) => {
    const spoken = extractTool(out).spoken;
    const hit = tokens.some((t) => spoken.includes(t));
    return hit ? { pass: true } : { pass: false, why: `answer missing ${label} (expected one of: ${tokens.join(", ")})` };
  },
};

// --- cases ------------------------------------------------------------------

const LEAD_ARGS = ["name", "phone", "company"];
const MEETING_ARGS = ["visitor_name", "visitor_company", "host_name", "host_company", "department"];

const cases = [
  {
    id: "ar-greeting-hours",
    desc: "Egyptian Arabic: working hours, paraphrased not read as JSON",
    turns: [{ role: "user", content: "السلام عليكم، مواعيد العمل عندكم إيه؟" }],
    checks: [assertions.arabicReply, assertions.noJsonLeak, assertions.noToolCall, assertions.brief(320)],
  },
  {
    id: "en-sectors",
    desc: "English: summarize sectors naturally, 2-3 items not the whole list",
    turns: [{ role: "user", content: "Hi, what does El Sewedy Electric actually do?" }],
    checks: [assertions.englishReply, assertions.noJsonLeak, assertions.noToolCall, assertions.brief(420)],
  },
  {
    id: "ar-partial-lead-must-ask",
    desc: "CRITICAL: only name given -> must ASK for phone+company, must NOT emit save_lead",
    turns: [{ role: "user", content: "أنا اسمي أحمد وعايز أعرف عن الكابلات بتاعتكم" }],
    checks: [assertions.arabicReply, assertions.noToolCall, assertions.noJsonLeak],
  },
  {
    id: "ar-full-lead-after-confirm",
    desc: "All 3 fields given + user confirms -> must emit save_lead with real values",
    turns: [
      { role: "user", content: "عايز أستفسر عن كابلات الجهد العالي" },
      { role: "assistant", content: "تمام، ممكن الاسم ورقم التليفون واسم الشركة؟" },
      { role: "user", content: "أحمد طارق، رقمي 01001234567، من شركة النيل للمقاولات" },
      { role: "assistant", content: "تمام يا أحمد، بياناتك: الرقم 01001234567 وشركة النيل للمقاولات. صح كده؟" },
      { role: "user", content: "أيوه صح" },
    ],
    checks: [
      assertions.toolCall("save_lead", LEAD_ARGS),
      assertions.arabicReply,
      assertions.noJsonLeak,
      assertions.noGreeting,
    ],
  },
  {
    id: "en-meeting-missing-fields",
    desc: "CRITICAL: meeting with only 2 of 5 fields -> must ask, never emit check_meeting",
    turns: [{ role: "user", content: "Hello, I have a meeting with Ahmed Sadek today." }],
    checks: [assertions.englishReply, assertions.noToolCall, assertions.noJsonLeak],
  },
  {
    id: "en-meeting-complete",
    desc: "All 5 meeting fields + confirmation -> check_meeting, names transliterated to Latin",
    turns: [
      { role: "user", content: "I have a meeting with Ahmed Sadek." },
      { role: "assistant", content: "May I have your name, your company, and which company and department you are visiting?" },
      { role: "user", content: "I'm John Miller from Siemens, meeting Ahmed Sadek at El Sewedy Electric, IT department." },
      { role: "assistant", content: "Just to confirm, you are John Miller from Siemens meeting Ahmed Sadek at El Sewedy Electric, IT department. Is that correct?" },
      { role: "user", content: "Yes, that's correct." },
    ],
    checks: [
      assertions.toolCall("check_meeting", MEETING_ARGS),
      assertions.englishReply,
      assertions.noJsonLeak,
    ],
  },
  {
    id: "ar-no-double-save",
    desc: "CRITICAL: after lead already saved, a normal question must NOT re-emit save_lead",
    turns: [
      { role: "user", content: "أحمد طارق، 01001234567، شركة النيل" },
      { role: "assistant", content: '<tool>{"name":"save_lead","args":{"name":"Ahmed Tarek","phone":"01001234567","company":"El Nil","interest":"Cables"}}</tool> تمام يا أحمد، سجلت بياناتك.' },
      { role: "user", content: "طيب إيه آخر أخبار الشركة؟" },
    ],
    checks: [assertions.arabicReply, assertions.noToolCall, assertions.noJsonLeak, assertions.noGreeting],
  },
  {
    id: "ar-no-hallucinated-lead",
    desc: "CRITICAL: vague interest, zero PII -> must ask, must not invent a lead",
    turns: [{ role: "user", content: "ممكن أعرف أسعار المحولات؟" }],
    checks: [assertions.arabicReply, assertions.noToolCall, assertions.noJsonLeak],
  },
  {
    id: "code-switch-ar-en",
    desc: "Egyptian speakers code-switch; reply must stay Arabic, not flip to English",
    turns: [{ role: "user", content: "أنا عايز أعرف عن الـ smart meters بتاعتكم، بتشتغل إزاي؟" }],
    checks: [assertions.arabicReply, assertions.noJsonLeak, assertions.brief(400)],
  },
  {
    id: "en-contact-info",
    desc: "Factual retrieval from company_info without dumping structure",
    turns: [{ role: "user", content: "What's your headquarters address?" }],
    checks: [
      assertions.englishReply,
      assertions.noJsonLeak,
      assertions.noToolCall,
      assertions.mentions(["New Cairo", "5th Settlement", "Cairo"], "the HQ location"),
    ],
  },
];

module.exports = { cases, assertions, extractTool, stripThink, PLACEHOLDER_PATTERNS };
