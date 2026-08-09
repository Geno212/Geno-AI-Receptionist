#!/usr/bin/env node
// Preflight check. Run this FIRST on a new machine:
//
//     node scripts/doctor.js
//
// Verifies every dependency, credential and provider the app needs, and prints
// a specific fix for anything broken. Exits non-zero if the app would fail to
// serve a visitor, so it is safe to gate a deploy on.
//
//     --quick   skip live API calls (offline / quota-preserving)

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const QUICK = process.argv.includes("--quick");
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

let failures = 0;
let warnings = 0;

function ok(label, detail = "") { console.log(`  ${C.green}PASS${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`); }
function fail(label, fix) { failures++; console.log(`  ${C.red}FAIL${C.reset} ${label}`); if (fix) console.log(`       ${C.yellow}fix: ${fix}${C.reset}`); }
function warn(label, note) { warnings++; console.log(`  ${C.yellow}WARN${C.reset} ${label}`); if (note) console.log(`       ${C.dim}${note}${C.reset}`); }
function section(t) { console.log(`\n${C.bold}${C.cyan}${t}${C.reset}`); }

async function main() {
  console.log(`${C.bold}Geno preflight${C.reset}${QUICK ? ` ${C.dim}(quick: no live API calls)${C.reset}` : ""}`);

  // ---------------------------------------------------------------- runtime
  section("Runtime");
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 18) ok("Node.js", `v${process.versions.node}`);
  else fail(`Node.js v${process.versions.node} is too old`, "install Node.js 18+ (fetch/FormData/Blob are required)");

  for (const g of ["fetch", "FormData", "Blob", "AbortController"]) {
    if (typeof globalThis[g] === "function") ok(`global ${g}`);
    else fail(`global ${g} missing`, "upgrade to Node.js 18+");
  }

  // ---------------------------------------------------------------- files
  section("Project files");
  const required = [
    "server.js", "db.json", "package.json",
    "lib/providers.js", "lib/system-prompt.js", "lib/languages.js",
    "src/client/index.html", "src/client/js/app.js", "src/client/css/styles.css",
  ];
  for (const f of required) {
    if (fs.existsSync(path.join(__dirname, "..", f))) ok(f);
    else fail(`missing ${f}`, "re-clone the repository");
  }

  if (fs.existsSync(path.join(__dirname, "..", "node_modules"))) ok("node_modules");
  else fail("node_modules missing", "run: npm install");

  if (fs.existsSync(path.join(__dirname, "..", ".env"))) ok(".env");
  else fail(".env missing", "run: cp .env.example .env   then fill in GROQ_API_KEY and ELEVENLABS_API_KEY");

  // db.json must parse and carry the knowledge base.
  try {
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "db.json"), "utf8"));
    if (db.company_info?.name) ok("db.json", `company_info: ${db.company_info.name}`);
    else warn("db.json has no company_info.name", "the assistant will have no knowledge base");
  } catch (e) {
    fail(`db.json is not valid JSON: ${e.message}`, "restore it from git: git checkout db.json");
  }

  // ---------------------------------------------------------------- modules
  section("Modules");
  let providers, prompt;
  try {
    providers = require("../lib/providers");
    ok("lib/providers.js loads");
  } catch (e) { fail(`lib/providers.js: ${e.message}`); }
  try {
    prompt = require("../lib/system-prompt");
    const p = prompt.buildSystemPrompt();
    ok("lib/system-prompt.js loads", `${p.length} chars (KB_MODE=${process.env.KB_MODE || "lean"})`);
    if (p.length > 12000) warn("system prompt is very large", "consider KB_MODE=lean to stay under rate limits");
  } catch (e) { fail(`lib/system-prompt.js: ${e.message}`); }

  // ---------------------------------------------------------------- config
  section("Provider configuration");
  if (!providers) { report(); return; }
  const status = providers.providerStatus();

  if (status.llm.configured) ok(`LLM: ${status.llm.provider}`, status.llm.model);
  else fail(`LLM provider "${status.llm.provider}" has no credentials`,
            status.llm.provider === "groq" ? "set GROQ_API_KEY in .env (https://console.groq.com/keys)"
                                           : `set the API key for ${status.llm.provider} in .env`);

  if (status.llm.fallbacks.length) ok("LLM fallbacks", status.llm.fallbacks.join(", "));
  else warn("no LLM_FALLBACKS configured",
            "free tiers throttle without warning; set LLM_FALLBACKS=cloudflare so visitors do not hit silence");

  if (status.stt.configured) ok(`STT: ${status.stt.provider}`, `${status.stt.model} (server-side: ${status.stt.serverSide})`);
  else fail("STT has no credentials", "set GROQ_API_KEY in .env, or set STT_SERVER_SIDE=0 to use browser recognition");

  if (status.tts.configured) ok(`TTS: ${status.tts.provider}`);
  else fail(`TTS provider "${status.tts.provider}" has no credentials`,
            status.tts.provider === "local" ? "start tts-server/ and set TTS_LOCAL_URL"
                                            : "set ELEVENLABS_API_KEY in .env");

  // ---------------------------------------------------------------- live
  if (QUICK) { report(); return; }

  section("Live API checks");

  // LLM
  try {
    const t = Date.now();
    const r = await providers.callLLMWithFallback([{ role: "user", content: "Reply with the single word: OK" }], { maxTokens: 8 });
    if (r.text) {
      const viaFallback = r.provider !== status.llm.provider;
      ok(`LLM responds`, `${Date.now() - t}ms via ${r.provider}${viaFallback ? " (FALLBACK - primary failed)" : ""}`);
      if (viaFallback) warn(`primary LLM "${status.llm.provider}" failed`, "check its key/quota; the fallback is covering for it");
    } else {
      fail(`LLM returned nothing: ${r.error?.message || "unknown"}`, "check the API key and that the daily quota is not exhausted");
    }
  } catch (e) { fail(`LLM call threw: ${e.message}`); }

  // STT (only when server-side is on)
  if (status.stt.serverSide) {
    try {
      // 0.4s of near-silence is enough to prove auth + decode without burning quota.
      const rate = 16000, n = rate * 0.4;
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 200), i * 2);
      const h = Buffer.alloc(44);
      h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
      h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write("data", 36); h.writeUInt32LE(pcm.length, 40);

      const t = Date.now();
      await providers.transcribe(Buffer.concat([h, pcm]), { filename: "probe.wav", language: "ar" });
      ok("STT responds", `${Date.now() - t}ms`);
    } catch (e) {
      if (e.isQuota) fail("STT quota exhausted", "wait for the daily reset, or set STT_SERVER_SIDE=0 to fall back to the browser engine");
      else fail(`STT failed: ${e.message}`, "verify GROQ_API_KEY");
    }
  }

  // TTS
  const ttsProvider = process.env.TTS_PROVIDER || "elevenlabs";
  if (ttsProvider === "local") {
    const url = (process.env.TTS_LOCAL_URL || "http://localhost:8020").replace(/\/$/, "");
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      ok("local TTS reachable", `device=${j.device} loaded=[${(j.models_loaded || []).join(",")}]`);
      if (j.device === "cpu") warn("local TTS is running on CPU", "synthesis will be far too slow for live use; check CUDA/torch install");
    } catch (e) {
      fail(`local TTS unreachable at ${url}`, "start it: cd tts-server && python server.py");
    }
  } else if (process.env.ELEVENLABS_API_KEY) {
    // Probe SYNTHESIS, not /user. ElevenLabs keys are scoped, and a key that
    // can synthesize speech perfectly well may still lack `user_read` --
    // checking the account endpoint reports a false failure for a working key.
    const voice = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
    try {
      const t = Date.now();
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=pcm_24000`,
        {
          method: "POST",
          headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ text: "اختبار", model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2" }),
          signal: AbortSignal.timeout(20000),
        }
      );
      if (r.ok) {
        const bytes = (await r.arrayBuffer()).byteLength;
        ok("ElevenLabs synthesizes", `${Date.now() - t}ms, ${bytes} bytes PCM`);
      } else {
        const detail = (await r.text().catch(() => "")).slice(0, 160);
        if (r.status === 401) fail("ElevenLabs rejected the key (401)", "check ELEVENLABS_API_KEY, and that it has text-to-speech permission");
        else if (r.status === 429) fail("ElevenLabs quota exhausted (429)", "top up the plan, or switch to TTS_PROVIDER=local");
        else fail(`ElevenLabs HTTP ${r.status}: ${detail}`, "verify ELEVENLABS_VOICE_ID and the model id");
      }
    } catch (e) { fail(`ElevenLabs check failed: ${e.message}`); }

    // Quota is a separate, optional read scope. Report it if permitted, but
    // never fail on it -- synthesis already proved the key works.
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const j = await r.json();
        const left = j.character_limit - j.character_count;
        console.log(`       ${C.dim}quota: ${j.character_count}/${j.character_limit} characters used${C.reset}`);
        if (left < j.character_limit * 0.1) warn(`only ${left} TTS characters remain`, "the receptionist goes mute when this hits zero");
      }
    } catch { /* optional scope; ignore */ }
  }

  report();
}

function report() {
  console.log();
  if (failures === 0 && warnings === 0) {
    console.log(`${C.green}${C.bold}All checks passed. Run: npm start${C.reset}`);
  } else if (failures === 0) {
    console.log(`${C.yellow}${C.bold}${warnings} warning(s), no blockers. The app will run: npm start${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}${failures} blocking problem(s)${warnings ? ` and ${warnings} warning(s)` : ""}. Fix the FAIL items above.${C.reset}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
