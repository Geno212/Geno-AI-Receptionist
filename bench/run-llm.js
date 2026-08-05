#!/usr/bin/env node
// Standalone LLM benchmark for the Geno receptionist migration.
//
//   node bench/run-llm.js                      # every provider with credentials
//   node bench/run-llm.js --provider groq      # one provider
//   node bench/run-llm.js --case ar-full-lead-after-confirm
//   node bench/run-llm.js --repeat 3           # N runs/case for consistency
//
// Scores each free-tier candidate on the failure modes that actually broke the
// Cloudflare implementation. Writes bench/out/llm-<timestamp>.json.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { providers, available, callLlm } = require("./providers/llm");
const { cases, stripThink } = require("./fixtures/llm-cases");
const { buildSystemPrompt } = require("./system-prompt");
const { MissingCredentialsError, QuotaError } = require("./providers/interface");

function parseArgs(argv) {
  const a = { provider: null, case: null, repeat: 1, model: null, noRetry: false };
  for (let i = 2; i < argv.length; i++) {
    const [k, inlineV] = argv[i].split("=");
    const next = () => inlineV ?? argv[++i];
    if (k === "--provider" || k === "-p") a.provider = next();
    else if (k === "--case" || k === "-c") a.case = next();
    else if (k === "--repeat" || k === "-r") a.repeat = parseInt(next(), 10) || 1;
    else if (k === "--model" || k === "-m") a.model = next();
    else if (k === "--no-retry") a.noRetry = true;
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Free tiers rate-limit on tokens-per-minute, and this benchmark resends a
 * ~10k-char system prompt every call, so a full run reliably trips the cap.
 * Providers report how long to wait ("try again in 5.065s"); honor it rather
 * than reporting a false failure. Capped so a genuinely exhausted DAILY quota
 * still aborts quickly instead of hanging.
 */
function retryDelayMs(err) {
  const m = /try again in ([\d.]+)s/i.exec(err.message || "");
  if (m) return Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 500, 65000);
  if (/per day|daily|RPD/i.test(err.message || "")) return null; // not worth waiting out
  return 20000;
}

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 100));

async function runCase(providerKey, testCase, systemPrompt, model) {
  const messages = [{ role: "system", content: systemPrompt }, ...testCase.turns];
  const res = await callLlm(providerKey, messages, model ? { model } : {});
  const cleaned = stripThink(res.text);

  const results = testCase.checks.map((check) => {
    try {
      return check(cleaned);
    } catch (e) {
      return { pass: false, why: `assertion threw: ${e.message}` };
    }
  });

  const failures = results.filter((r) => !r.pass).map((r) => r.why);
  return {
    caseId: testCase.id,
    desc: testCase.desc,
    passed: failures.length === 0,
    failures,
    latencyMs: res.latencyMs,
    output: cleaned,
    usage: res.meta.usage,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log("Usage: node bench/run-llm.js [--provider groq] [--case <id>] [--repeat N] [--model <id>]");
    console.log("\nProviders:");
    for (const [k, p] of Object.entries(providers)) {
      console.log(`  ${k.padEnd(12)} ${p.label} (${p.envVars.join(", ")})${p.trainsOnData ? "  [TRAINS ON YOUR DATA]" : ""}`);
    }
    console.log("\nCases:");
    for (const c of cases) console.log(`  ${c.id.padEnd(30)} ${c.desc}`);
    return;
  }

  const systemPrompt = buildSystemPrompt();
  const selected = args.provider ? [args.provider] : available();

  if (selected.length === 0) {
    console.error(`${C.red}No LLM provider credentials found in .env${C.reset}\n`);
    console.error("Add at least one of these free-tier keys, then re-run:\n");
    console.error("  GROQ_API_KEY       https://console.groq.com/keys        (free, no training on your data)");
    console.error("  CEREBRAS_API_KEY   https://cloud.cerebras.ai/           (free, no training on your data)");
    console.error("  OPENROUTER_API_KEY https://openrouter.ai/keys           (free tier MAY train on prompts)");
    process.exitCode = 1;
    return;
  }

  const selectedCases = args.case ? cases.filter((c) => c.id === args.case) : cases;
  if (selectedCases.length === 0) {
    console.error(`${C.red}No case matching "${args.case}"${C.reset}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${C.bold}Geno LLM benchmark${C.reset} ${C.dim}(Egyptian Arabic + English)${C.reset}`);
  console.log(`${C.dim}system prompt: ${systemPrompt.length} chars | cases: ${selectedCases.length} | repeat: ${args.repeat}${C.reset}\n`);

  const report = { startedAt: new Date().toISOString(), providers: {} };

  for (const providerKey of selected) {
    const p = providers[providerKey];
    if (!p) {
      console.error(`${C.red}unknown provider "${providerKey}"${C.reset}`);
      continue;
    }
    const model = args.model || p.defaultModel;
    console.log(`${C.bold}${C.cyan}${p.label}${C.reset} ${C.dim}(${model})${C.reset}`);
    if (p.trainsOnData) {
      console.log(`  ${C.yellow}WARNING: this free tier may train on your prompts - unsuitable for visitor PII${C.reset}`);
    }

    const entry = { label: p.label, model, trainsOnData: p.trainsOnData, cases: [], latencies: [] };
    let aborted = null;
    let quotaRetries = 0;
    const MAX_QUOTA_RETRIES = 12;

    for (const testCase of selectedCases) {
      if (aborted) break;
      for (let attempt = 1; attempt <= args.repeat; attempt++) {
        try {
          const r = await runCase(providerKey, testCase, systemPrompt, model);
          entry.cases.push(r);
          entry.latencies.push(r.latencyMs);
          const tag = r.passed ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
          const rep = args.repeat > 1 ? ` ${C.dim}#${attempt}${C.reset}` : "";
          console.log(`  ${tag} ${testCase.id}${rep} ${C.dim}${r.latencyMs}ms${C.reset}`);
          if (!r.passed) {
            for (const f of r.failures) console.log(`       ${C.red}- ${f}${C.reset}`);
            console.log(`       ${C.dim}got: ${r.output.replace(/\s+/g, " ").slice(0, 180)}${C.reset}`);
          }
        } catch (e) {
          if (e instanceof MissingCredentialsError) {
            console.log(`  ${C.yellow}SKIP - ${e.message}${C.reset}`);
            aborted = "missing-credentials";
          } else if (e instanceof QuotaError) {
            const waitMs = args.noRetry ? null : retryDelayMs(e);
            if (waitMs && quotaRetries < MAX_QUOTA_RETRIES) {
              quotaRetries++;
              console.log(`  ${C.dim}rate limited (TPM); waiting ${(waitMs / 1000).toFixed(1)}s...${C.reset}`);
              await sleep(waitMs);
              attempt--; // redo this attempt, don't count it as a run
              continue;
            }
            console.log(`  ${C.yellow}QUOTA EXHAUSTED - ${e.message}${C.reset}`);
            aborted = "quota";
          } else {
            console.log(`  ${C.red}ERROR ${testCase.id}: ${e.message}${C.reset}`);
            entry.cases.push({ caseId: testCase.id, passed: false, failures: [e.message], error: true });
          }
          break;
        }
      }
    }

    entry.aborted = aborted;
    const total = entry.cases.length;
    const passed = entry.cases.filter((c) => c.passed).length;
    entry.score = { passed, total, pct: pct(passed, total) };

    if (entry.latencies.length) {
      const sorted = [...entry.latencies].sort((a, b) => a - b);
      entry.latency = {
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1],
        maxMs: sorted[sorted.length - 1],
      };
      console.log(
        `  ${C.bold}${passed}/${total} (${entry.score.pct}%)${C.reset}  ` +
        `${C.dim}median ${entry.latency.medianMs}ms | p95 ${entry.latency.p95Ms}ms${C.reset}\n`
      );
    } else {
      console.log(`  ${C.dim}no results${C.reset}\n`);
    }

    report.providers[providerKey] = entry;
  }

  // Summary: correctness first, then latency. For a voice agent both gate.
  const ranked = Object.entries(report.providers)
    .filter(([, e]) => e.score.total > 0)
    .sort((a, b) => b[1].score.pct - a[1].score.pct || (a[1].latency?.medianMs ?? 1e9) - (b[1].latency?.medianMs ?? 1e9));

  if (ranked.length > 1) {
    console.log(`${C.bold}Ranking${C.reset}`);
    for (const [k, e] of ranked) {
      const lat = e.latency ? `${e.latency.medianMs}ms` : "n/a";
      const warn = e.trainsOnData ? ` ${C.yellow}[trains on data]${C.reset}` : "";
      console.log(`  ${String(e.score.pct).padStart(3)}%  ${k.padEnd(12)} ${C.dim}median ${lat}${C.reset}${warn}`);
    }
    console.log();
  }

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `llm-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`${C.dim}report -> ${path.relative(process.cwd(), outFile)}${C.reset}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
