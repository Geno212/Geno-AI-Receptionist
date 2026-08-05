# Geno migration bench

Standalone harnesses for evaluating a **free, self-hostable** replacement for the
current paid stack, before any of it is integrated into `server.js`.

**Scope: Egyptian Arabic + English only.** Chinese and Japanese are out of scope
as of 2026-07.

| Layer | Now (paid) | Candidate | License |
|---|---|---|---|
| LLM | Cloudflare Workers AI | Gemini 2.5 Flash / Groq / Cerebras | free tier |
| STT | Browser Web Speech API | Groq Whisper (now) -> Cohere Transcribe Arabic (on GPU) | MIT / Apache-2.0 |
| TTS | ElevenLabs | NAMAA-Egyptian-TTS / Chatterbox | MIT |

Provider quotas come from **[cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources)**.

Training-on-data is **not** a selection constraint (owner decision, 2026-07), so
Gemini's free tier is in play — it has the highest quota (1,500 req/day) and the
strongest Arabic. Each provider still records `trainsOnData` as a factual note
for El Sewedy's procurement side.

## Why not Fish Audio

It was the original proposal, and it does not work here:

- `fish-speech` / S2-Pro weights are under the **Fish Audio Research License** —
  commercial use, *including internal business operations*, requires a paid
  agreement.
- `openaudio-s1-mini` is **CC-BY-NC-SA-4.0** — non-commercial only.
- Fish Audio is **TTS-only**; there is no Fish STT, so it never covered half the pipeline.

Self-hosting does not change this: the restriction is on *use*, not hosting.
When evaluating any other model, check the **weights** license on Hugging Face —
not a blog headline, and not the paper's license (Fish Audio's paper is CC BY 4.0
while its weights are not).

## Setup

Add whichever free keys you have to `.env`:

```
GEMINI_API_KEY=...      # https://aistudio.google.com/apikey   1,500 req/day — best Arabic
GROQ_API_KEY=...        # https://console.groq.com/keys        LLM + free Whisper STT
CEREBRAS_API_KEY=...    # https://cloud.cerebras.ai/           1M tokens/day, lowest latency
COHERE_API_KEY=...      # https://dashboard.cohere.com/api-keys  best Arabic STT
```

One `GROQ_API_KEY` covers **both** LLM and STT, so it is the single highest-value
key to create first.

Each harness runs only the providers whose credentials are present, and prints
signup links for the rest.

## Running

```bash
node bench/run-llm.js                 # all providers with credentials
node bench/run-llm.js --provider groq
node bench/run-llm.js --case ar-full-lead-after-confirm --repeat 3
node bench/run-llm.js --help          # list providers and cases

node bench/run-tts.js --lang ar       # writes playable WAVs to bench/out/audio/
node bench/run-stt.js                 # needs a golden set (below)
```

Reports are written to `bench/out/*.json` (gitignored).

## What the LLM harness tests

Not generic prompts — the ten cases target the failure modes that actually broke
the Cloudflare implementation and that the production system prompt is written to
defend against:

- premature tool emission before all required fields are collected
- hallucinated placeholders (`John Doe`, `Unknown`, `123456789`)
- language drift (English question answered in Arabic, or switching mid-reply)
- raw JSON or the words "tool"/"JSON" leaking into spoken output
- re-emitting `save_lead` after the lead was already saved
- re-greeting every turn / repeating the caller's name

The harness scores the **production** prompt. `lib/system-prompt.js` is the single
source of truth; `bench/system-prompt.js` is a thin re-export and `server.js`
requires the same module, so bench and production cannot drift.

### Results (2026-07-29, incumbent Cloudflare `llama-3.3-70b-fp8-fast`)

| | Score | Median | p95 |
|---|---|---|---|
| Before fixes | 9/10 | 2208ms | 3750ms |
| After fixes | **20/20** (2 full runs) | 2527ms | 7497ms |

Two real production bugs were found and fixed in `lib/system-prompt.js`:

**1. Language drift (failed 3/3).** An English visitor saying *"I have a meeting
with Ahmed Sadek"* was answered in Arabic, despite an explicit prompt rule.
Cause: the prompt named Arabic first and framed Geno as an Egyptian receptionist,
and that prior beat the rule. Fix: state language selection first, as a
*mechanical* test on the script of the user's last message, with the
meeting/Arabic-name case called out as an explicit exception.

**2. Placeholder tool calls.** Masked by bug 1 — once English replies started
working, the model emitted `check_meeting` with literal `"?"` for every
uncollected field, which would have written junk meeting records into the DB.
Cause: the old prompt banned specific strings (`John Doe`, `Unknown`), which
taught it to substitute *different* filler. Fix: state the rule as a
precondition ("did the user literally tell me this? if no for any argument, do
not emit the tool") instead of a blocklist. Detection in `llm-cases.js` was also
widened to catch the `?`/`N/A`/`none`/`[...]` family.

Both fixes live in the prompt, so they carry to whichever provider is chosen.

**Latency is the remaining reason to switch.** p95 of 7.5s on the incumbent is a
7-second silence for a visitor.

### Groq vs incumbent (2026-07-29, same prompt, same cases)

| Provider | Model | Score | Median | Notes |
|---|---|---|---|---|
| **Groq** | llama-3.3-70b-versatile | **10/10** | **858ms** | ~3x faster |
| Cloudflare | llama-3.3-70b-fp8-fast | 20/20 | 2527ms | p95 7497ms |

**Groq wins on latency by roughly 3x** at identical correctness — median 858ms vs
2527ms, with a best case of 333ms. For a voice agent this is the difference
between a natural pause and an awkward silence.

**But the free tier caps at 12,000 tokens/minute**, and this benchmark trips it
constantly because the ~10k-char system prompt is resent on every call. The
runner now honors the provider's `try again in Ns` hint and retries
(`--no-retry` to disable).

This TPM ceiling is a **production** constraint, not just a benchmark one.

### Prompt shrink (done)

`node bench/run-prompt-size.js` measured which parts of the prompt are actually
load-bearing:

| Variant | Tokens | Score | Verdict |
|---|---|---|---|
| full | ~2516 | 10/10 | baseline |
| **lean KB** | **~1673** | **10/10** | **adopted** (`KB_MODE=lean`) |
| without STYLE | ~2361 | FAIL | `en-sectors` returned 824 chars vs a 420 limit |

**34% fewer tokens at identical correctness.** The saving is entirely in the
knowledge base, not the behaviour rules: `db.json`'s `company_info` was 55% of
the prompt, and `key_contacts` alone was 2,023 chars because it embedded each
person's full LinkedIn work history (roles from the 1990s at other employers).
A receptionist needs to know *who* someone is, not their 30-year career.

Dropping STYLE **broke brevity** — proof the section earns its tokens. Trimming
by intuition rather than measurement would have removed the wrong thing.

Remaining lever if more headroom is needed: trim conversation history instead of
resending every turn in full.

### Groq's real quotas (discovered by exhausting them)

Documented limits are per-minute, but there is also a **daily token cap** that
the free-tier docs do not surface prominently:

- 12,000 tokens/minute (TPM)
- **100,000 tokens/day (TPD)** — this is the one that actually bites
- 1,000 requests/day

A full 10-case benchmark run costs ~20-25k tokens, so roughly **4 full runs per
day**. Plan benchmark work accordingly; `run-llm.js` and `run-prompt-size.js`
both honor the provider's `try again in Ns` hint, but a TPD exhaustion is not
worth waiting out and aborts immediately.

## Building the STT golden set

The STT harness needs **real audio**, not TTS-generated clips — synthesizing test
audio would only measure whether one model can hear another, not whether it
understands an actual Egyptian visitor in a noisy lobby.

1. Record 15–30 short clips of things visitors really say (greetings, meeting
   requests, names, phone numbers, ar/en code-switching). Use the actual reception
   mic, with realistic background noise.
2. Save as 16 kHz mono WAV in `bench/fixtures/golden/`.
3. Create `bench/fixtures/golden/manifest.json`:

```json
{
  "decodeParams": { "temperature": 0 },
  "clips": [
    {
      "file": "visitor-meeting-01.wav",
      "lang": "ar",
      "reference": "أنا عندي ميعاد مع الأستاذ أحمد صادق من شركة سيمنس",
      "keywords": ["أحمد صادق", "سيمنس"]
    }
  ]
}
```

`reference` is the exact human transcript. `keywords` are terms where an error is
disproportionately costly — host names, company names — scored separately from WER,
because mis-hearing a host's name fails the visitor even at a good overall WER.

Scoring normalizes Arabic first (diacritics, alef/hamza variants, ta marbuta,
Arabic-Indic digits), so WER reflects real recognition errors rather than
orthographic noise.

## Hosted vs self-hosted: they are not identical

Same weights do **not** mean same behavior. Four divergence sources:

1. **Latency** — datacenter GPU with batching vs. an on-prem box. For a voice
   agent this alone can turn a good demo into an unusable deployment.
2. **Decode params** — hosted endpoints apply their own beam/temperature/VAD
   defaults that differ from local inference defaults. Pin them explicitly;
   that's why `manifest.decodeParams` is threaded through to every provider.
3. **Audio format** — hosted TTS returns MP3/fixed rate; local NAMAA emits raw
   tensors at `model.sr`. The client requires **PCM 24 kHz 16-bit mono LE**.
4. **Streaming** — neither open model is natively streaming; they synthesize whole
   utterances, so TTFB equals full synthesis time.

Every provider reports the decode params it used in `meta.params`, so hosted and
local runs over the same golden set produce a measurable diff.

## Hardware note

This dev machine has an **MX350 (2 GB VRAM)** — far too small for Cohere Transcribe
(2B) or NAMAA (0.5B). Local providers (`stt.local`, `tts.namaa`) are wired but
cannot be exercised here; they need El Sewedy's GPU box, pointed at via
`STT_LOCAL_URL` / `TTS_LOCAL_URL`.

## Client audio contract

Defined once in `providers/interface.js` as `CLIENT_AUDIO_CONTRACT` and enforced
by the TTS harness: raw **PCM 24 kHz, 16-bit, mono, little-endian**, terminated by
a `{"type":"tts_end"}` JSON message. This mirrors `server.js:1366-1373`. Any TTS
provider that honors it drops in without touching `public/client.html`.
