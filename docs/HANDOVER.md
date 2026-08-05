# Geno — Handover & Setup Guide

Everything needed to run, understand, and finish this project. Written to be
followed start-to-finish on a machine that has never seen the repo.

Last updated: 2026-07-29

- [1. What this is](#1-what-this-is)
- [2. Where the project stands](#2-where-the-project-stands)
- [3. Exact setup on a new laptop](#3-exact-setup-on-a-new-laptop)
- [4. The complete flow](#4-the-complete-flow)
- [5. Usage caps and what they mean](#5-usage-caps-and-what-they-mean)
- [6. Switching to the fully free stack](#6-switching-to-the-fully-free-stack)
- [7. Configuration reference](#7-configuration-reference)
- [8. Testing](#8-testing)
- [9. Troubleshooting](#9-troubleshooting)
- [10. What is left to do](#10-what-is-left-to-do)

---

## 1. What this is

**Geno** is a browser-based AI receptionist for **El Sewedy Electric**. A visitor
walks up, speaks, and Geno:

- answers questions about the company (hours, sectors, contacts, news),
- verifies visitors who claim to have a **meeting**, and
- captures **sales leads** (name, phone, company).

**Languages: Egyptian Arabic and English only.** Chinese and Japanese were
dropped in July 2026; if you find traces of them, they are leftovers.

It is a **web app, not a phone system.** Earlier Twilio telephony work is dead
and lives in [`legacy/`](../legacy/).

### Why the project restarted

Development was paused because the paid API bill (ElevenLabs + Azure + Cloudflare)
made it too expensive to maintain. The July 2026 work replaced most of that stack
with free providers, and prepared a path to remove the last paid piece.

---

## 2. Where the project stands

### Current stack

| Layer | Provider | Model | Cost | Status |
|---|---|---|---|---|
| **LLM** | Groq | `llama-3.3-70b-versatile` | **free** | working, benchmarked 10/10 |
| **STT** | Groq | `whisper-large-v3` | **free** | working, ~750 ms |
| **TTS** | ElevenLabs | `eleven_multilingual_v2` | **paid** | working — the last cost |

### What was measured, not guessed

**LLM choice.** Groq vs the previous Cloudflare setup, same prompt, same cases:

| | Score | Median latency | p95 |
|---|---|---|---|
| **Groq** | **10/10** | **858 ms** (best 333 ms) | 4 924 ms |
| Cloudflare (old) | 10/10 | 2 527 ms | 7 497 ms |

Identical correctness, roughly **3× faster**. For a voice agent that is the
difference between a natural pause and an awkward silence.

**Two production bugs were found and fixed** by the benchmark harness:

1. **Language drift** — an English visitor saying *"I have a meeting with Ahmed
   Sadek"* was answered **in Arabic**, reproducibly (3/3). The prompt's
   Arabic-first framing overpowered its own reply-language rule.
2. **Placeholder tool calls** — once English replies worked, the model emitted
   `check_meeting` with literal `"?"` for every field it had not collected,
   which **would have written junk meeting records into `db.json`**.

Both fixes live in [`lib/system-prompt.js`](../lib/system-prompt.js) and are
explained there. **Do not "tidy" the LANGUAGE or TOOLS sections without
re-running `npm run bench`** — each encodes a fix for a bug that reached
production.

**Prompt size.** The system prompt is resent every turn, so its size sets how
many turns fit inside the rate limit:

| Variant | Tokens | Benchmark |
|---|---|---|
| `KB_MODE=full` | ~2 516 | 10/10 |
| **`KB_MODE=lean`** (default) | **~1 673** | **10/10** |
| without the STYLE section | ~2 361 | **FAILED** |

34 % fewer tokens at identical correctness. The saving was entirely in the
knowledge base — `db.json`'s `company_info` was 55 % of the prompt, and
`key_contacts` alone was 2 023 characters because it embedded each person's full
LinkedIn work history (including a role from 1992). Cutting the *behaviour*
rules instead broke brevity, which is why STYLE stays.

**STT quality.** ~10 % WER on clean Arabic, transcribing dialect words like
"الصبح" and "المغرب" that the old browser engine mangled. **Caveat: measured on
studio-clean synthesized audio, never on real lobby noise.**

### What is verified vs unverified

| | Status |
|---|---|
| LLM behaviour (10 cases) | verified — `npm run bench` |
| `/stt` endpoint | verified end-to-end with real audio files |
| LLM fallback chain | verified — a bad Groq key was transparently served by Cloudflare |
| Server endpoints, startup, port-clash handling | verified |
| **Browser microphone flow** | **NOT verified — needs a human at a mic** |
| **STT on real lobby audio** | **NOT verified — needs recordings** |
| **Self-hosted TTS** | **NOT verified — code written, never executed (no GPU here)** |

The unverified items are unverified because they need hardware or a human, not
because they were skipped.

---

## 3. Exact setup on a new laptop

### Prerequisites

- **Node.js 18 or newer** — check with `node --version`. Node 18+ is required
  for built-in `fetch`, `FormData` and `Blob`; the app will not run on older
  versions.
- **Git**
- *(Only for the fully free TTS path)* Python 3.10+ and an NVIDIA GPU.

### Step 1 — Clone and install

```bash
git clone https://github.com/Geno212/Geno-AI-Receptionist.git
cd Geno-AI-Receptionist
npm install
```

### Step 2 — Create the config file

```bash
cp .env.example .env
```

Open `.env` and set **two** keys:

```bash
GROQ_API_KEY=gsk_...        # https://console.groq.com/keys
ELEVENLABS_API_KEY=sk_...   # https://elevenlabs.io  → Profile → API Key
```

The Groq key covers **both** the LLM and speech-to-text, so it is the single
most important one. Signup is free and needs no credit card.

Everything else in `.env.example` already has a working default.

> `.env` is gitignored. Never commit it — it holds live credentials.

### Step 3 — Run the preflight check

```bash
npm run doctor
```

**Do this before `npm start`.** It verifies the Node version, dependencies,
`.env`, every credential, and makes one live call to each provider — then prints
an exact fix for anything broken. Expected output:

```
Geno preflight

Runtime
  PASS Node.js v22.22.0
  ...
Provider configuration
  PASS LLM: groq  llama-3.3-70b-versatile
  PASS LLM fallbacks  cloudflare
  PASS STT: groq  whisper-large-v3 (server-side: true)
  PASS TTS: elevenlabs

Live API checks
  PASS LLM responds  345ms via groq
  PASS STT responds  299ms
  PASS ElevenLabs synthesizes  776ms, 49040 bytes PCM

All checks passed. Run: npm start
```

Use `npm run doctor:quick` to skip live API calls (offline, or to preserve
quota).

### Step 4 — Start

```bash
npm start
```

You should see:

```
Geno listening on http://localhost:3000  (public: ...)
  LLM  groq / llama-3.3-70b-versatile (fallback: cloudflare)
  STT  groq / whisper-large-v3
  TTS  elevenlabs
```

### Step 5 — Test it

1. Open **http://localhost:3000**
2. Allow microphone access when prompted.
3. Click **Call**. Geno greets you in Arabic and English.
4. Speak. Try each of these:

| Say this | Expected |
|---|---|
| "مواعيد العمل عندكم إيه؟" | Egyptian Arabic reply about working hours |
| "What does El Sewedy Electric do?" | **English** reply (not Arabic) about sectors |
| "I have a meeting with Ahmed Sadek" | **English** reply asking for your name and company |
| "أنا اسمي أحمد وعايز أعرف عن الكابلات" | Arabic reply asking for phone + company |

The third one is the regression test for the language-drift bug. **If Geno
answers that in Arabic, something reverted** — re-run `npm run bench`.

> **Microphone note:** browsers only allow microphone access on `localhost` or
> over HTTPS. Opening the page by IP (e.g. `http://192.168.1.5:3000`) from
> another device will silently fail to get mic permission. Use a tunnel
> (`ngrok http 3000`) and set `PUBLIC_URL` for remote testing.

---

## 4. The complete flow

### 4.1 End to end

```
┌─── BROWSER ──────────────────────────────────────────────────────────────┐
│                                                                          │
│  1. Visitor clicks "Call"                                                │
│  2. getUserMedia() → mic stream → AudioContext analyser (visualizer+VAD)  │
│  3. WebSocket opens to /client-ws                                        │
│  4. Server sends the greeting as audio immediately                       │
│                                                                          │
│  5. MediaRecorder starts recording the visitor                           │
│  6. Every 50 ms: read mic volume                                         │
│        volume > VAD_THRESHOLD (15)  → speech detected                    │
│        quiet for SILENCE_MS (1200)  → utterance over, stop recording     │
│        (hard cap: MAX_UTTERANCE_MS = 20 000)                             │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  POST /stt   (audio blob, ~webm/opus)
                             ▼
┌─── SERVER ───────────────────────────────────────────────────────────────┐
│  7. /stt → lib/providers.transcribe() → Groq Whisper                     │
│     language pinned to "ar" (auto-detect flip-flops on short ar/en)      │
│     temperature 0 for determinism                                        │
│  8. Returns {"ok":true,"text":"...","latencyMs":756}                     │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  transcript back to browser
                             ▼
              browser sends over the WebSocket:
              {"type":"text","text":"مواعيد العمل عندكم إيه؟"}
                             │
                             ▼
┌─── SERVER: handleTurn() ─────────────────────────────────────────────────┐
│                                                                          │
│   9. If the AI is currently speaking → input is DISCARDED (no barge-in)  │
│  10. Append the turn to conversation history                             │
│  11. Build messages = [system prompt] + history                          │
│  12. lib/providers.callLLMWithFallback()                                 │
│         primary  : Groq llama-3.3-70b                                    │
│         fallback : Cloudflare  (on 429 / error / empty)                  │
│  13. Strip <think>…</think> (reasoning models leak these)                │
│  14. Empty reply? → language-matched apology instead of silence          │
│  15. Extract <tool>{...}</tool> with a regex                             │
│         save_lead     → fuzzy-dedupe → db.json customers                 │
│         check_meeting → fuzzy-match  → db.json meetings → approval flow  │
│  16. Strip the tool tag from what gets spoken                            │
│  17. speak(remaining text)                                               │
└────────────────────────────┬─────────────────────────────────────────────┘
                             ▼
┌─── SERVER: speak() ──────────────────────────────────────────────────────┐
│  18. Push onto an audio queue (utterances never overlap)                 │
│  19. Normalize text for speech:                                          │
│        Arabic → 24 h times become spoken Arabic ("9 الصبح")              │
│        English → 1938 becomes "nineteen thirty-eight"                    │
│        emails → "info at elsewedy dot com"                               │
│  20. TTS_PROVIDER = elevenlabs → stream PCM straight through             │
│                   = local      → POST to the GPU sidecar, strip WAV      │
│                                  header, send PCM in ~20 ms frames       │
│  21. Send binary PCM frames over the SAME WebSocket                      │
│  22. Send {"type":"tts_end"} to mark the end of the utterance            │
└────────────────────────────┬─────────────────────────────────────────────┘
                             ▼
      Browser: ArrayBuffer frames → Web Audio API, scheduled back-to-back
      On tts_end → playback finishes → recording restarts for the next turn
```

### 4.2 The audio contract

The most important interface in the system. Any TTS backend **must** produce:

| Property | Value |
|---|---|
| Encoding | raw PCM, **no container/header** |
| Sample rate | **24 000 Hz** |
| Bit depth | 16-bit signed |
| Channels | mono |
| Byte order | little-endian |
| Transport | binary WebSocket frames |
| End marker | `{"type":"tts_end"}` as a **text** frame |

The client tells audio from control messages by frame type: `ArrayBuffer` =
audio, string = JSON. **`tts_end` is mandatory** — without it the client waits
forever. The local TTS path sends it even on failure for that reason.

### 4.3 Speech-to-text: two modes

**Server-side (default, `STT_SERVER_SIDE=1`).** The browser records with
`MediaRecorder`, endpoints with the volume VAD, and POSTs to `/stt`. Works in
**every** browser and handles Egyptian dialect well.

**Browser-side (`STT_SERVER_SIDE=0`).** Chrome's `webkitSpeechRecognition`.
Zero server cost, but Chrome-only and noticeably weaker on dialect.

**Automatic fallback:** if `/stt` errors or `MediaRecorder` is missing, the
client silently drops to browser recognition. A speech-service outage degrades
quality instead of killing the microphone.

### 4.4 Why tools are parsed with a regex

The prompt asks the model to emit `<tool>{...}</tool>` and the server parses it
with a regex, rather than using native function calling. This was a workaround
for the old Cloudflare models being unreliable at structured output.

Groq supports native tool calling and migrating would be cleaner — but the
current approach benchmarks 10/10, and switching would invalidate that. Left
deliberately.

---

## 5. Usage caps and what they mean

### Groq free tier (verified 2026-07-29, by exhausting them)

| Limit | Value | Practical meaning |
|---|---|---|
| Tokens/minute | 12 000 | ~7 conversation turns per minute |
| **Tokens/day** | **100 000** | **the real ceiling — see below** |
| Requests/day | 1 000 | plenty; never the constraint |
| Whisper requests/day | 2 000 | plenty |
| Whisper audio/day | 28 800 s (8 h) | plenty |

**The 100 000 tokens/day cap is what will actually bite you.** It is not
prominent in Groq's docs — it was discovered by hitting it.

At ~1 673 prompt tokens per turn plus conversation history, that works out to
roughly **40–60 full conversations per day**. A busy reception desk can exceed
that.

It also means a full benchmark run (~20–25 k tokens) can be done about **4 times
per day**. Plan testing accordingly.

**What happens when you hit it:** Groq returns HTTP 429, and
`callLLMWithFallback` automatically retries on Cloudflare. The visitor notices
nothing except slightly higher latency. The log prints:

```
[llm] groq failed: [groq] quota/rate limit: ...
[llm] served by fallback provider "cloudflare"
```

**This is why `LLM_FALLBACKS` matters.** Without it, a throttled free tier means
the visitor hears silence.

### ElevenLabs

Character-based, depends on your plan (free ≈ 10 000 chars/month, paid tiers
from ~$5/month). A typical reply is 80–150 characters, so the free tier is
roughly **70–120 replies per month** — enough for demos, not for a live desk.

`npm run doctor` reports remaining characters when the key has the `user_read`
scope.

### Cost summary

| Layer | Before | Now | Fully free (§6) |
|---|---|---|---|
| LLM | Cloudflare (paid) | **$0** | $0 |
| STT | browser (free, Chrome-only) | **$0** | $0 |
| TTS | ElevenLabs $22–99/mo | ElevenLabs $22–99/mo | **$0** |
| **Total** | **$22–99/mo** | **$22–99/mo** | **$0 + one-time GPU** |

**Be precise about this when reporting upward:** LLM and STT are now free, and
speech recognition got *better* in the process. But the monthly bill has not
dropped yet, because TTS was always the bulk of it. The saving is realized only
after §6.

---

## 6. Switching to the fully free stack

This removes the ElevenLabs bill entirely by running TTS on your own GPU.

### Requirements

- NVIDIA GPU, **8 GB VRAM** (both models resident). With 4–6 GB, set
  `TTS_LAZY_UNLOAD=1` to keep one model loaded at a time — slower on language
  switches, but it fits.
- Python 3.10+
- ~3 GB disk for model weights

### The models

| Language | Model | License |
|---|---|---|
| Egyptian Arabic | [NAMAA-Egyptian-TTS](https://huggingface.co/NAMAA-Space/NAMAA-Egyptian-TTS) | **MIT** |
| English | [Chatterbox Multilingual](https://huggingface.co/ResembleAI/chatterbox) | **MIT** |

Both are MIT — free for commercial use, self-hostable, no strings. They share
the Chatterbox architecture, so one code path serves both.

> **Why not Fish Audio?** It was the original candidate and it does **not**
> qualify. Its weights are under the Fish Audio Research License (commercial use,
> *including internal business operations*, needs a paid agreement) and
> `openaudio-s1-mini` is CC-BY-NC-SA-4.0 — non-commercial only. It is also
> TTS-only, so it never covered speech recognition. Self-hosting does not change
> this: the restriction is on *use*, not hosting. When evaluating any model,
> check the **weights** license on Hugging Face — not a blog headline, and not
> the paper's license.

### Steps

**1. Install PyTorch matched to your CUDA version.** Check your CUDA with
`nvidia-smi`, then:

```bash
cd tts-server
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

Getting this wrong installs the CPU build, which "works" but is far too slow for
live conversation. `npm run doctor` will warn you if the sidecar reports CPU.

**2. Install the rest and start it:**

```bash
pip install -r requirements.txt
python server.py            # listens on :8020, downloads weights on first run
```

**3. Point Geno at it** — in `.env`:

```bash
TTS_PROVIDER=local
TTS_LOCAL_URL=http://localhost:8020
```

**4. Verify:**

```bash
curl localhost:8020/health   # {"ok":true,"device":"cuda","models_loaded":["ar"]}
npm run doctor               # confirms reachability and CUDA vs CPU
npm start
```

### Before trusting it in production

**Listen to it.** Nobody has yet confirmed the free Arabic TTS meets El Sewedy's
quality bar — that is a human judgment, not a benchmark:

```bash
npm run bench:tts -- --provider namaa --lang ar
# then play the WAV files written to bench/out/audio/
```

Ask specifically: does it sound **Egyptian**, or does it drift toward Modern
Standard Arabic or a Levantine accent? Is "السويدي إليكتريك" pronounced
correctly?

### Making Geno sound like one person

By default the Arabic and English models use their own built-in voices, so Geno
sounds like two different people. Record one ~10-second clip and point both
variables at it for a consistent voice:

```bash
TTS_AR_VOICE_REF=/path/to/geno-voice.wav
TTS_EN_VOICE_REF=/path/to/geno-voice.wav
```

### Known trade-off

The open models are **not streaming** — they synthesize a whole utterance, so
the first audio byte arrives only when synthesis finishes. Expect a higher
time-to-first-byte than ElevenLabs, though total latency can still be lower on a
fast GPU. Full detail: [`tts-server/README.md`](../tts-server/README.md).

---

## 7. Configuration reference

Everything lives in `.env`. Only `GROQ_API_KEY` and a TTS backend are mandatory.

### LLM

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `groq` | `groq` \| `cerebras` \| `gemini` \| `openrouter` \| `cloudflare` |
| `GROQ_API_KEY` | — | **required** — also powers STT |
| `LLM_FALLBACKS` | `cloudflare` | Comma-separated chain tried when the primary fails |
| `LLM_MODEL` | per-provider | Override the model id |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | — | Needed only if Cloudflare is primary or a fallback |

Alternative free providers (from
[cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources)):
`GEMINI_API_KEY` (1 500 req/day, strongest Arabic), `CEREBRAS_API_KEY`
(1 M tokens/day, lowest latency), `OPENROUTER_API_KEY`.

### STT

| Variable | Default | Purpose |
|---|---|---|
| `STT_SERVER_SIDE` | `1` | `1` = Groq Whisper, `0` = browser Web Speech API |
| `STT_PROVIDER` | `groq` | Backend |
| `STT_MODEL` | `whisper-large-v3` | Model id |

### TTS

| Variable | Default | Purpose |
|---|---|---|
| `TTS_PROVIDER` | `elevenlabs` | `elevenlabs` (paid) or `local` (free, GPU) |
| `ELEVENLABS_API_KEY` | — | Required when using ElevenLabs |
| `ELEVENLABS_VOICE_ID` | `EXAVITQu4vr4xnSDxMaL` | Voice ("Sarah") |
| `TTS_LOCAL_URL` | `http://localhost:8020` | Sidecar address when `local` |

### Prompt and behaviour

| Variable | Default | Purpose |
|---|---|---|
| `KB_MODE` | `lean` | `lean` = trimmed knowledge base (34 % fewer tokens), `full` = everything |
| `GREETING_ON_START` | `1` | Speak a greeting when the call opens |
| `GREETING_TEXT` | bilingual | Opening line |
| `LOG_TRANSCRIPTS` | `1` | Log STT transcripts to the console |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | `localhost` | Public URL when behind a tunnel |

### Tuning the microphone

In [`public/client.html`](../public/client.html):

| Constant | Default | Effect |
|---|---|---|
| `VAD_THRESHOLD` | `15` | Mic level counted as speech. Raise in a noisy lobby. |
| `SILENCE_MS` | `1200` | Quiet time before the utterance is considered finished. Lower = snappier but cuts people off mid-pause. |
| `MAX_UTTERANCE_MS` | `20000` | Hard cap on one recording. |

These are the most likely things to need adjusting after the first real test.

---

## 8. Testing

```bash
npm run doctor          # preflight: deps, config, live API calls
npm run bench           # 10 receptionist behaviour cases
npm run bench:prompt    # prompt token cost vs. pass rate
npm run bench:tts       # TTS latency + audio contract; writes playable WAVs
npm run bench:stt       # STT accuracy (needs a recorded golden set)
```

`npm run bench` is the regression suite. It covers the real failure modes:
premature tool calls, hallucinated placeholders, language drift, JSON leaking
into speech, duplicate lead saves, and re-greeting. **Run it after any prompt
change.** Budget ~20–25 k tokens per run against the 100 k daily cap.

### Recording the STT golden set (still outstanding)

`npm run bench:stt` needs real audio. Synthesized clips would only prove one
model can hear another — not that it understands a visitor in a noisy lobby.

1. Record 15–30 short clips of what visitors actually say — greetings, meeting
   requests, names, phone numbers, Arabic/English code-switching. Use the real
   reception microphone with realistic background noise.
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
disproportionately costly (host names, company names) — scored separately,
because mis-hearing a host's name fails the visitor even at a good overall WER.

Scoring normalizes Arabic first (diacritics, alef/hamza variants, ta marbuta,
Arabic-Indic digits), so the number reflects real recognition errors rather than
spelling variation.

> Golden-set WAVs are gitignored — they may contain real visitors' voices.

---

## 9. Troubleshooting

**`Port 3000 is already in use`**
Another instance is running. Stop it, or `PORT=3001 npm start`.

**`npm run doctor` says a provider has no credentials**
The key is missing or misspelled in `.env`. The doctor prints the exact variable
name and signup URL.

**Geno answers an English question in Arabic**
The language-drift bug has regressed. Run `npm run bench` — the
`en-meeting-missing-fields` case covers exactly this. Check whether
[`lib/system-prompt.js`](../lib/system-prompt.js)'s LANGUAGE section was edited.

**Microphone does nothing / no permission prompt**
Browsers only grant mic access on `localhost` or HTTPS. Opening the page by LAN
IP will fail silently. Use `ngrok http 3000` and set `PUBLIC_URL`.

**Geno hears nothing, but the mic works elsewhere**
`VAD_THRESHOLD` may be too high for your microphone, or ambient noise too high
for `SILENCE_MS` to ever trigger. Open the browser console — the STT mode is
logged at startup.

**Replies are slow, log shows `served by fallback provider`**
Groq's daily token cap is exhausted. Expected behaviour: Cloudflare is covering.
Resets on a rolling 24 h window.

**Geno goes silent mid-conversation**
Usually ElevenLabs characters ran out. Check `npm run doctor`; switch to
`TTS_PROVIDER=local` (§6) or top up the plan.

**Local TTS is extremely slow**
The CPU build of PyTorch is installed. `curl localhost:8020/health` — if
`device` is `cpu`, reinstall torch with the correct CUDA index URL.

**Arabic shows as `?????` in the terminal**
Windows console encoding only; the data is fine. Verify with
`node -e "fetch(...)"` rather than `curl` in cmd.

---

## 10. What is left to do

Ordered by what unblocks the most.

### 1. Test the microphone flow with a real person
The one thing no amount of code review substitutes for. Follow §3 step 5. Expect
to tune `VAD_THRESHOLD` and `SILENCE_MS`.

### 2. Record the STT golden set (§8)
~20 minutes of recording. Until this exists, "Whisper handles Egyptian dialect"
is supported only by clean synthetic audio.

### 3. Stand up the free TTS and listen to it (§6)
This is what actually removes the monthly bill. The code is written but has
never run — expect first-run friction around CUDA/torch versions.

### 4. Decide on the GPU
A one-time ~$1 600–2 000 card (or ~$150–300/month cloud) permanently removes a
$22–99/month bill **and** keeps visitor audio in-house. The demo justifies the
ask.

### Known limitations

- **No barge-in.** While Geno speaks, visitor input is *discarded* rather than
  interrupting playback (the `isSpeaking` flag). Fixing it properly means
  cancelling the audio queue on speech detection.
- **Conversation history grows unbounded** within a session, so a long
  conversation drifts toward the token cap. Trimming old turns is the next
  lever after the prompt shrink.
- **`db.json` is a flat file.** Fine for one reception desk; concurrent writes
  would race. `db.sql` holds a Postgres schema for later.
- **Tool calls are regex-parsed** rather than native function calls (§4.4).

### Further reading

| Document | Contents |
|---|---|
| [`README.md`](../README.md) | Quick start and cost summary |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | Deeper technical detail on the flow |
| [`bench/README.md`](../bench/README.md) | Benchmark harnesses and results |
| [`tts-server/README.md`](../tts-server/README.md) | Self-hosted TTS setup |
| [`legacy/README.md`](../legacy/README.md) | What the old Twilio/Azure code was |
