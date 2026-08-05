#!/usr/bin/env node
// Prompt-size experiment.
//
// Groq's free tier caps at 12,000 tokens/minute. The Geno system prompt is
// resent on every turn, so prompt size directly sets how many conversation
// turns/minute are possible before throttling. This finds the SMALLEST prompt
// variant that still passes every behavioural case.
//
//   node bench/run-prompt-size.js                 # all variants, all cases
//   node bench/run-prompt-size.js --provider groq
//
// Variants are defined below, ordered largest -> smallest. Each is scored on
// the same 10 cases as run-llm.js, so a regression is immediately visible.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { providers, available, callLlm } = require("./providers/llm");
const { cases, stripThink } = require("./fixtures/llm-cases");
const { buildSystemPrompt } = require("./system-prompt");
const { QuotaError, MissingCredentialsError } = require("./providers/interface");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rough token estimate. Arabic is far less token-efficient than English under
// BPE (often ~1 token per 1-2 chars vs ~4 chars for English), so a plain
// chars/4 estimate badly understates a bilingual prompt. Weight by script.
function estimateTokens(text) {
  const arabic = (text.match(/[؀-ۿ]/g) || []).length;
  const other = text.length - arabic;
  return Math.ceil(arabic / 1.5 + other / 4);
}

const ALL_SECTIONS = ["IDENTITY", "LANGUAGE", "STYLE", "LEADS", "MEETINGS", "TOOLS"];

// Measured 2026-07-29 on Groq llama-3.3-70b:
//   full             10/10  ~2516 tok
//   no-style          FAIL   -- dropping STYLE broke brevity: `en-sectors`
//                               returned 824 chars against a 420 limit. STYLE
//                               is load-bearing; do not remove it.
//   lean-kb          10/10  ~1673 tok  <- adopted
// The saving comes from the knowledge base, not from cutting behaviour rules.
const VARIANTS = [
  { id: "full", desc: "all sections (current)", include: ALL_SECTIONS },
  { id: "lean-kb", desc: "full sections, trimmed knowledge base", include: ALL_SECTIONS, leanKb: true },
];

/**
 * The knowledge base is the single biggest chunk of the prompt: db.json's
 * company_info is JSON.stringify'd wholesale into every request (5,461 chars,
 * 55% of the whole prompt).
 *
 * The worst offender is `key_contacts` (2,023 chars) -- it embeds each person's
 * full LinkedIn work history, including roles from the 1990s at other
 * employers. A receptionist needs to know WHO someone is, not their 30-year
 * career. This collapses each contact to name + profile and drops
 * `work_history` and `linkedin` entirely.
 */
function leanCompanyInfo(info) {
  const take = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : arr);
  const slimContacts = (arr) =>
    (Array.isArray(arr) ? arr : []).map((c) => ({
      name: c.name,
      // Keep the first sentence or so of the profile: enough to answer "who is
      // X?" without the full employment record.
      profile: typeof c.profile === "string" ? c.profile.split(/(?<=\.)\s/).slice(0, 2).join(" ") : c.profile,
    }));

  return {
    name: info.name,
    description: info.description,
    headquarters: info.headquarters,
    contact: info.contact,
    working_hours: info.working_hours,
    sectors: take(info.sectors, 5),
    key_facts: take(info.key_facts, 4),
    recent_news: take(info.recent_news, 2),
    leadership: (info.leadership || []).map((l) => ({ name: l.name, title: l.title })),
    key_contacts: slimContacts(info.key_contacts),
  };
}

function parseArgs(argv) {
  const a = { provider: null };
  for (let i = 2; i < argv.length; i++) {
    const [k, v] = argv[i].split("=");
    if (k === "--provider" || k === "-p") a.provider = v ?? argv[++i];
  }
  return a;
}

async function runCase(providerKey, testCase, systemPrompt, model) {
  const messages = [{ role: "system", content: systemPrompt }, ...testCase.turns];
  const res = await callLlm(providerKey, messages, { model });
  const cleaned = stripThink(res.text);
  const failures = testCase.checks
    .map((c) => { try { return c(cleaned); } catch (e) { return { pass: false, why: e.message }; } })
    .filter((r) => !r.pass).map((r) => r.why);
  return { passed: failures.length === 0, failures, latencyMs: res.latencyMs, output: cleaned };
}

/**
 * Groq reports the exact wait in its error body ("try again in 5.065s").
 * Honor that; the previous flat 20s fallback wasted minutes because the TPM
 * bucket typically refills in well under a second.
 */
async function withQuotaRetry(fn, label) {
  let waited = 0;
  const MAX_TOTAL_WAIT_MS = 120000;
  for (let i = 0; i < 20; i++) {
    try { return await fn(); } catch (e) {
      if (!(e instanceof QuotaError)) throw e;
      if (/per day|daily|RPD/i.test(e.message || "")) throw e; // daily quota: don't wait it out
      const m = /try again in ([\d.]+)(m?s)/i.exec(e.message || "");
      let wait = 6000;
      if (m) wait = Math.ceil(parseFloat(m[1]) * (m[2] === "ms" ? 1 : 1000)) + 300;
      wait = Math.min(wait, 30000);
      if (waited + wait > MAX_TOTAL_WAIT_MS) break;
      waited += wait;
      process.stdout.write(`${C.dim}    (rate limited, waiting ${(wait / 1000).toFixed(1)}s)\n${C.reset}`);
      await sleep(wait);
    }
  }
  throw new QuotaError(label, "exhausted retries", 429);
}

async function main() {
  const args = parseArgs(process.argv);
  const providerKey = args.provider || available()[0];
  if (!providerKey) { console.error(`${C.red}No provider credentials found.${C.reset}`); process.exitCode = 1; return; }
  const p = providers[providerKey];
  const model = p.defaultModel;

  const { loadCompanyInfo } = require("./system-prompt");
  const fullInfo = loadCompanyInfo();

  console.log(`${C.bold}Prompt-size experiment${C.reset} ${C.dim}(${p.label}, ${model})${C.reset}`);
  console.log(`${C.dim}Goal: smallest prompt that still passes all ${cases.length} cases.${C.reset}\n`);

  const report = { provider: providerKey, model, startedAt: new Date().toISOString(), variants: [] };

  for (const v of VARIANTS) {
    const info = v.leanKb ? leanCompanyInfo(fullInfo) : fullInfo;
    const prompt = buildSystemPrompt({ info, include: v.include });
    const tokens = estimateTokens(prompt);
    // 12,000 TPM budget; each turn also carries history + completion, so this
    // is an optimistic ceiling on turns/minute, not a promise.
    const turnsPerMin = Math.floor(12000 / Math.max(tokens, 1));

    console.log(`${C.bold}${C.cyan}${v.id}${C.reset} ${C.dim}${v.desc}${C.reset}`);
    console.log(`  ${C.dim}${prompt.length} chars | ~${tokens} tokens | ~${turnsPerMin} turns/min at 12k TPM${C.reset}`);

    const entry = { id: v.id, desc: v.desc, chars: prompt.length, tokens, turnsPerMin, results: [] };
    let failed = 0;

    for (const tc of cases) {
      try {
        const r = await withQuotaRetry(() => runCase(providerKey, tc, prompt, model), providerKey);
        entry.results.push({ caseId: tc.id, ...r });
        if (!r.passed) {
          failed++;
          console.log(`  ${C.red}FAIL${C.reset} ${tc.id}`);
          for (const f of r.failures) console.log(`       ${C.red}- ${f}${C.reset}`);
        }
      } catch (e) {
        if (e instanceof MissingCredentialsError) { console.log(`  ${C.yellow}SKIP ${e.message}${C.reset}`); break; }
        console.log(`  ${C.red}ERROR ${tc.id}: ${e.message}${C.reset}`);
        entry.results.push({ caseId: tc.id, passed: false, failures: [e.message], error: true });
        failed++;
      }
    }

    const total = entry.results.length;
    const passed = total - failed;
    entry.score = { passed, total };
    const ok = failed === 0;
    console.log(`  ${ok ? C.green : C.red}${passed}/${total}${C.reset}${ok ? `  ${C.green}(safe to adopt)${C.reset}` : ""}\n`);
    report.variants.push(entry);
  }

  // Recommend the smallest variant that kept a perfect score.
  const safe = report.variants.filter((v) => v.score.passed === v.score.total && v.score.total === cases.length);
  if (safe.length) {
    const best = safe.reduce((a, b) => (b.tokens < a.tokens ? b : a));
    const full = report.variants.find((v) => v.id === "full");
    const saved = full ? Math.round((1 - best.tokens / full.tokens) * 100) : 0;
    console.log(`${C.bold}${C.green}Recommended: "${best.id}"${C.reset}`);
    console.log(`  ~${best.tokens} tokens (${saved}% smaller than full), ~${best.turnsPerMin} turns/min vs ~${full?.turnsPerMin ?? "?"}\n`);
    report.recommended = best.id;
  } else {
    console.log(`${C.yellow}No reduced variant kept a perfect score - keep the full prompt.${C.reset}\n`);
  }

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `prompt-size-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`${C.dim}report -> ${path.relative(process.cwd(), outFile)}${C.reset}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
