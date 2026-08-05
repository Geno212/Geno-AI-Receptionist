#!/usr/bin/env node
// TTS benchmark: measures latency, verifies the client PCM contract, and
// writes WAV files for human listening (the only test that really matters
// for voice quality).
//
//   node bench/run-tts.js                    # every provider with credentials
//   node bench/run-tts.js --provider namaa
//   node bench/run-tts.js --lang ar
//
// Outputs bench/out/audio/<provider>-<case>.wav + a JSON report.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { providers, available, synthesize, analyzePcm, TARGET_RATE } = require("./providers/tts");
const { pcmToWav, MissingCredentialsError, QuotaError } = require("./providers/interface");
const { phrases } = require("./fixtures/tts-phrases");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

function parseArgs(argv) {
  const a = { provider: null, lang: null, case: null };
  for (let i = 2; i < argv.length; i++) {
    const [k, inlineV] = argv[i].split("=");
    const next = () => inlineV ?? argv[++i];
    if (k === "--provider" || k === "-p") a.provider = next();
    else if (k === "--lang" || k === "-l") a.lang = next();
    else if (k === "--case" || k === "-c") a.case = next();
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log("Usage: node bench/run-tts.js [--provider <k>] [--lang ar|en] [--case <id>]\n");
    console.log("Providers:");
    for (const [k, p] of Object.entries(providers)) {
      console.log(`  ${k.padEnd(12)} ${p.label} ${C.dim}[${p.license}, ${p.cost}]${C.reset} (${p.envVars.join(", ") || "no creds"})`);
    }
    console.log("\nPhrases:");
    for (const ph of phrases) console.log(`  ${ph.id.padEnd(22)} [${ph.lang}] ${ph.text.slice(0, 60)}`);
    return;
  }

  const selected = args.provider ? [args.provider] : available();
  if (selected.length === 0) {
    console.error(`${C.red}No TTS provider credentials found.${C.reset}\n`);
    console.error("  ELEVENLABS_API_KEY  incumbent baseline (already in .env)");
    console.error("  TTS_LOCAL_URL       self-hosted NAMAA/Chatterbox endpoint, e.g. http://localhost:8020");
    process.exitCode = 1;
    return;
  }

  let selectedPhrases = phrases;
  if (args.lang) selectedPhrases = selectedPhrases.filter((p) => p.lang === args.lang);
  if (args.case) selectedPhrases = selectedPhrases.filter((p) => p.id === args.case);
  if (selectedPhrases.length === 0) {
    console.error(`${C.red}No phrases matched the filters.${C.reset}`);
    process.exitCode = 1;
    return;
  }

  const audioDir = path.join(__dirname, "out", "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  console.log(`${C.bold}Geno TTS benchmark${C.reset} ${C.dim}(client contract: PCM ${TARGET_RATE}Hz/16-bit/mono)${C.reset}\n`);
  const report = { startedAt: new Date().toISOString(), targetRate: TARGET_RATE, providers: {} };

  for (const key of selected) {
    const p = providers[key];
    if (!p) { console.error(`${C.red}unknown provider "${key}"${C.reset}`); continue; }

    console.log(`${C.bold}${C.cyan}${p.label}${C.reset} ${C.dim}[${p.license}, ${p.cost}]${C.reset}`);
    const entry = { label: p.label, license: p.license, cost: p.cost, results: [] };
    let aborted = null;

    for (const ph of selectedPhrases) {
      if (aborted) break;
      try {
        const r = await synthesize(key, { text: ph.text, params: ph.params || {} });
        const stats = analyzePcm(r.pcm, TARGET_RATE);

        // Contract + sanity checks.
        const issues = [];
        if (stats.silent) issues.push("output is silent (rms < 50)");
        if (stats.clippedPct > 1) issues.push(`clipping on ${stats.clippedPct}% of samples`);
        if (stats.durationSec < 0.3) issues.push(`suspiciously short: ${stats.durationSec.toFixed(2)}s`);
        if (r.meta.resampled) issues.push(`native ${r.sampleRate}Hz resampled to ${TARGET_RATE}Hz`);

        const wav = pcmToWav(r.pcm, TARGET_RATE);
        const outPath = path.join(audioDir, `${key}-${ph.id}.wav`);
        fs.writeFileSync(outPath, wav);

        // Real-time factor: <1 means synthesis is faster than playback, which
        // is the bar for a live voice agent.
        const rtf = stats.durationSec > 0 ? r.latencyMs / 1000 / stats.durationSec : Infinity;

        entry.results.push({ caseId: ph.id, lang: ph.lang, ttfbMs: r.ttfbMs, latencyMs: r.latencyMs, rtf: +rtf.toFixed(2), stats, issues, wav: path.relative(process.cwd(), outPath) });

        const tag = issues.length ? `${C.yellow}WARN${C.reset}` : `${C.green}OK  ${C.reset}`;
        console.log(`  ${tag} ${ph.id.padEnd(22)} ${C.dim}ttfb ${String(r.ttfbMs).padStart(5)}ms | ${stats.durationSec.toFixed(2)}s audio | rtf ${rtf.toFixed(2)}${C.reset}`);
        for (const i of issues) console.log(`       ${C.yellow}- ${i}${C.reset}`);
      } catch (e) {
        if (e instanceof MissingCredentialsError) { console.log(`  ${C.yellow}SKIP - ${e.message}${C.reset}`); aborted = "missing-credentials"; }
        else if (e instanceof QuotaError) { console.log(`  ${C.yellow}QUOTA - ${e.message}${C.reset}`); aborted = "quota"; }
        else { console.log(`  ${C.red}ERROR ${ph.id}: ${e.message}${C.reset}`); entry.results.push({ caseId: ph.id, error: e.message }); }
      }
    }

    entry.aborted = aborted;
    const ok = entry.results.filter((r) => !r.error);
    if (ok.length) {
      const ttfbs = ok.map((r) => r.ttfbMs).sort((a, b) => a - b);
      entry.ttfb = { medianMs: ttfbs[Math.floor(ttfbs.length / 2)], maxMs: ttfbs[ttfbs.length - 1] };
      console.log(`  ${C.bold}median TTFB ${entry.ttfb.medianMs}ms${C.reset} ${C.dim}| audio -> bench/out/audio/${C.reset}\n`);
    } else {
      console.log(`  ${C.dim}no results${C.reset}\n`);
    }
    report.providers[key] = entry;
  }

  console.log(`${C.bold}Listen before deciding.${C.reset} ${C.dim}Latency numbers do not capture dialect quality;`);
  console.log(`play the Arabic clips in bench/out/audio/ and judge whether they sound Egyptian.${C.reset}\n`);

  const outDir = path.join(__dirname, "out");
  const outFile = path.join(outDir, `tts-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`${C.dim}report -> ${path.relative(process.cwd(), outFile)}${C.reset}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
