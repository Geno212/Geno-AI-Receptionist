/**
 * Resolve a visitor meeting from free-text without waiting for the LLM tool.
 * Matches visitor + host names (Latin or common Arabic spellings) against Supabase rows.
 */

const NAME_ALIASES = {
  john: ["john", "جون"],
  miller: ["miller", "ميلر", "ميللر"],
  asser: ["asser", "aser", "أسر", "آسر", "اسر", "aser"],
  emad: ["emad", "عماد"],
  ahmed: ["ahmed", "ahmad", "أحمد", "احمد"],
  sadek: ["sadek", "صادق"],
  mohamed: ["mohamed", "muhammad", "محمد"],
  zamzam: ["zamzam", "زمزم"],
  siemens: ["siemens", "سيمينز", "سيمنز", "سيمونز", "سيمنس"],
  sara: ["sara", "sarah", "سارة"],
  hassan: ["hassan", "حسن"],
  omar: ["omar", "عمر"],
  farouk: ["farouk", "farouq", "فاروق"],
  orascom: ["orascom", "أوراسكوم", "اوراسكوم"],
  nile: ["nile", "النيل"],
};

function fold(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasesForToken(token) {
  const t = fold(token);
  if (NAME_ALIASES[t]) return NAME_ALIASES[t].map(fold);
  return [t];
}

function textMentionsPerson(text, fullName, isSimilar) {
  const fText = fold(text);
  const parts = fold(fullName).split(/\s+/).filter((p) => p.length >= 3);
  if (!parts.length) return false;
  const words = fText.split(/\s+/);
  return parts.every((part) => {
    const aliases = aliasesForToken(part);
    if (aliases.some((a) => a.length >= 3 && fText.includes(a))) return true;
    return words.some((w) => w.length >= 3 && (isSimilar(w, part, 0.68) || aliases.some((a) => isSimilar(w, a, 0.68))));
  });
}

function isMeetingIntent(text) {
  return /مقابل|ميعاد|موعد|هقابل|هقابله|meeting|appointment|\bmeet\b|here to see|i'?m here for/i.test(
    text || ""
  );
}

/**
 * @param {string} text
 * @param {object[]} meetings flattened rows from listMeetingsForMatch
 * @param {(a:string,b:string,t?:number)=>boolean} isSimilar
 */
function findMeetingInText(text, meetings, isSimilar) {
  if (!text || !meetings?.length) return null;
  const intent = isMeetingIntent(text);
  const hits = [];
  for (const m of meetings) {
    const hostOk = textMentionsPerson(text, m.host_name, isSimilar);
    const visitorOk = textMentionsPerson(text, m.visitor_name, isSimilar);
    if (hostOk && visitorOk) {
      let score = 3;
      if (m.visitor_company && textMentionsPerson(text, m.visitor_company, isSimilar)) score += 1;
      hits.push({ m, score });
    } else if (intent && hostOk && !visitorOk) {
      // Host only — useful when visitor name comes in a later turn
      hits.push({ m, score: 1, hostOnly: true });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length) return null;
  if (hits[0].score >= 3) return { match: hits[0].m, confidence: "high" };
  if (hits.length === 1 && hits[0].score >= 1) return { match: hits[0].m, confidence: "low", hostOnly: hits[0].hostOnly };
  return { match: hits[0].m, confidence: "ambiguous", candidates: hits.slice(0, 3).map((h) => h.m) };
}

function isConfirmation(text) {
  return /^(yes|yeah|yep|correct|right|sure|exactly|ok|okay|اه|ايوه|أيوه|ايوة|تمام|صح|مظبوط|نعم)\b/i.test(
    (text || "").trim()
  ) || /\b(yes|correct|right|اه|ايوة|تمام|صح|مظبوط)\b/i.test(text || "");
}

module.exports = {
  findMeetingInText,
  isMeetingIntent,
  isConfirmation,
  textMentionsPerson,
};
