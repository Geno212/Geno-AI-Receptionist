#!/usr/bin/env node
// STT benchmark: scores providers on a golden set of Egyptian Arabic + English
// clips, using Arabic-aware WER plus domain keyword recall.
//
//   node bench/run-stt.js                     # every provider with credentials
//   node bench/run-stt.js --provider cohere
//
// The golden set lives in bench/fixtures/golden/ with a manifest.json that maps
// each audio file to its human reference transcript. Record it yourself -- see
// bench/README.md. Real El Sewedy reception audio beats synthetic clips,
// because the thing being measured is dialect and lobby noise.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { providers, available, transcribe, wordErrorRate, keywordRecall } = require("./providers/stt");
const { MissingCredentialsError, QuotaError } = require("./providers/interface");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const GOLDEN_DIR = path.join(__dirname, "fixtures", "golden");
const MANIFEST = path.join(GOLDEN_DIR, "manifest.json");

function parseArgs(argv) {
  const a = { provider: null };
  for (let i = 2; i < argv.length; i++) {
    const [k, inlineV] = argv[i].split("=");
    const next = () => inlineV ?? argv[++i];
    if (k === "--provider" || k === "-p") a.provider = next();
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log("Usage: node bench/run-stt.js [--provider cohere|local|webspeech]\n");
    console.log("Providers:");
    for (const [k, p] of Object.entries(providers)) {
      console.log(`  ${k.padEnd(12)} ${p.label} ${C.dim}[${p.license}]${C.reset} (${p.envVars.join(", ") || "no creds"})`);
    }
    return;
  }

  const manifest = loadManifest();
  if (!manifest || !manifest.clips?.length) {
    console.error(`${C.yellow}No golden set found at ${path.relative(process.cwd(), MANIFEST)}${C.reset}\n`);
    console.error("The STT benchmark needs real Egyptian Arabic audio with human reference");
    console.error("transcripts. Synthetic TTS audio would only measure whether one model can");
    console.error("hear another -- not whether it understands an actual visitor.\n");
    console.error("To build it (see bench/README.md):");
    console.error("  1. Record 15-30 short clips of the phrases El Sewedy visitors really say");
    console.error("     (reception lobby, phone mic, some background noise).");
    console.error("  2. Save them as 16kHz mono WAV in bench/fixtures/golden/");
    console.error("  3. Write manifest.json mapping each file to its exact transcript.\n");
    process.exitCode = 1;
    return;
  }

  const selected = args.provider ? [args.provider] : available();
  if (selected.length === 0) {
    console.error(`${C.red}No STT provider credentials found.${C.reset}\n`);
    console.error("  COHERE_API_KEY   https://dashboard.cohere.com/api-keys  (free tier, Apache-2.0 weights)");
    console.error("  STT_LOCAL_URL    self-hosted endpoint, e.g. http://localhost:8010");
    process.exitCode = 1;
    return;
  }

  console.log(`${C.bold}Geno STT benchmark${C.reset} ${C.dim}(${manifest.clips.length} clips)${C.reset}\n`);
  const report = { startedAt: new Date().toISOString(), providers: {} };

  for (const key of selected) {
    const p = providers[key];
    if (!p) { console.error(`${C.red}unknown provider "${key}"${C.reset}`); continue; }

    console.log(`${C.bold}${C.cyan}${p.label}${C.reset} ${C.dim}[${p.license}]${C.reset}`);
    const entry = { label: p.label, license: p.license, kind: p.kind, results: [] };
    let aborted = null;

    for (const clip of manifest.clips) {
      if (aborted) break;
      const audioPath = path.join(GOLDEN_DIR, clip.file);
      if (!fs.existsSync(audioPath)) {
        console.log(`  ${C.yellow}MISSING ${clip.file}${C.reset}`);
        continue;
      }
      try {
        const r = await transcribe(key, { audioPath, params: manifest.decodeParams || {} });
        const wer = wordErrorRate(clip.reference, r.text);
        const kw = keywordRecall(r.text, clip.keywords || []);
        entry.results.push({ file: clip.file, lang: clip.lang, reference: clip.reference, hypothesis: r.text, wer: +wer.wer.toFixed(4), edits: wer.edits, refWords: wer.ref, keywordRecall: +kw.recall.toFixed(3), missedKeywords: kw.missed, latencyMs: r.latencyMs });

        const werPct = (wer.wer * 100).toFixed(1);
        const color = wer.wer <= 0.15 ? C.green : wer.wer <= 0.3 ? C.yellow : C.red;
        console.log(`  ${color}WER ${werPct.padStart(5)}%${C.reset} ${clip.file.padEnd(24)} ${C.dim}kw ${(kw.recall * 100).toFixed(0)}% | ${r.latencyMs}ms${C.reset}`);
        if (kw.missed.length) console.log(`       ${C.yellow}missed: ${kw.missed.join(", ")}${C.reset}`);
        if (wer.wer > 0.3) {
          console.log(`       ${C.dim}ref: ${clip.reference}${C.reset}`);
          console.log(`       ${C.dim}hyp: ${r.text}${C.reset}`);
        }
      } catch (e) {
        if (e instanceof MissingCredentialsError) { console.log(`  ${C.yellow}SKIP - ${e.message}${C.reset}`); aborted = "missing-credentials"; }
        else if (e instanceof QuotaError) { console.log(`  ${C.yellow}QUOTA - ${e.message}${C.reset}`); aborted = "quota"; }
        else { console.log(`  ${C.red}ERROR ${clip.file}: ${e.message}${C.reset}`); entry.results.push({ file: clip.file, error: e.message }); }
      }
    }

    entry.aborted = aborted;
    const ok = entry.results.filter((r) => !r.error);
    if (ok.length) {
      // Corpus WER = total edits / total reference words (not a mean of per-clip
      // rates, which would over-weight short clips).
      const totalEdits = ok.reduce((s, r) => s + r.edits, 0);
      const totalRef = ok.reduce((s, r) => s + r.refWords, 0);
      entry.corpusWer = +(totalEdits / totalRef).toFixed(4);
      entry.meanKeywordRecall = +(ok.reduce((s, r) => s + r.keywordRecall, 0) / ok.length).toFixed(3);
      console.log(`  ${C.bold}corpus WER ${(entry.corpusWer * 100).toFixed(1)}% | keyword recall ${(entry.meanKeywordRecall * 100).toFixed(0)}%${C.reset}\n`);
    } else {
      console.log(`  ${C.dim}no results${C.reset}\n`);
    }
    report.providers[key] = entry;
  }

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `stt-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`${C.dim}report -> ${path.relative(process.cwd(), outFile)}${C.reset}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
