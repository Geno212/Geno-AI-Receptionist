# Geno — Architecture & Request Flow

How a visitor's spoken sentence becomes a spoken answer, and where every
decision is made.

**Scope:** Egyptian Arabic + English. Browser-based (no telephony).

---

## 1. High-level flow

```
┌──────────────────────── BROWSER (public/client.html) ────────────────────────┐
│                                                                              │
│  mic ──► MediaRecorder ──► volume VAD (endpointing)                          │
│                              │                                               │
│                              ▼  utterance complete                           │
└──────────────────────────────┼───────────────────────────────────────────────┘
                               │  POST /stt   (audio blob)
                               ▼
┌──────────────────────── SERVER (server.js) ──────────────────────────────────┐
│                                                                              │
│  /stt ──► lib/providers.transcribe() ──► Groq Whisper ──► transcript         │
│                                                                              │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │  transcript returned to browser
                               ▼
                    browser sends over WebSocket
                    /client-ws  {"type":"text","text":"..."}
                               │
                               ▼
┌──────────────────────── SERVER: handleTurn() ────────────────────────────────┐
│                                                                              │
│  conversation history + lib/system-prompt.js                                 │
│         │                                                                    │
│         ▼                                                                    │
│  lib/providers.callLLMWithFallback()                                         │
│         ├─ primary:  Groq llama-3.3-70b                                      │
│         └─ fallback: Cloudflare  (on 429 / error)                            │
│         │                                                                    │
│         ▼  reply text, possibly containing <tool>{...}</tool>                │
│  parse tool ──► save_lead / check_meeting ──► db.json                        │
│         │                                                                    │
│         ▼  spoken text (tool tags stripped)                                  │
│  speak() ──► audio queue ──► ElevenLabs  or  local TTS sidecar               │
│         │                                                                    │
│         ▼  binary PCM frames over the SAME WebSocket                         │
│      ...then {"type":"tts_end"}                                              │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ▼
                    browser Web Audio API plays PCM
```

---

## 2. The audio contract

This is the single most important interface. Any TTS backend must honour it:

| Property | Value |
|---|---|
| Encoding | raw PCM, **no container** |
| Sample rate | **24 000 Hz** |
| Bit depth | 16-bit signed |
| Channels | mono |
| Byte order | little-endian |
| Transport | binary WebSocket frames |
| End sentinel | `{"type":"tts_end"}` as a **text** frame |

The client distinguishes audio from control messages by frame type
(`ArrayBuffer` = audio, string = JSON control). It plays PCM through the Web
Audio API, scheduling each chunk after the previous one.

`tts_end` is mandatory — without it the client waits forever for more audio. The
local TTS path sends it even on error for exactly this reason.

---

## 3. Speech-to-text: two modes

### Server-side (default, `STT_SERVER_SIDE=1`)

The browser records the utterance with `MediaRecorder` and posts the blob to
`/stt`, which forwards it to Groq Whisper.

**Endpointing** reuses the visualizer's existing volume analysis: once speech has
been detected and the level stays below `VAD_THRESHOLD` for 1 200 ms, recording
stops and the blob is sent. A 20 s hard cap prevents a runaway recording.

Why this is the default: it works in **every** browser and handles Egyptian
dialect far better than the Web Speech API (which frequently mangles words like
"الصبح" / "المغرب").

### Browser-side (fallback, `STT_SERVER_SIDE=0`)

Chrome's `webkitSpeechRecognition`. Free and zero-latency-to-server, but
Chrome-only and weaker on dialect.

**Automatic fallback:** the client drops to browser recognition if `/stt` returns
an error or `MediaRecorder` is unavailable. A speech-service outage degrades
quality rather than killing the microphone.

---

## 4. LLM turn handling

`handleTurn(text)` in `server.js`:

1. If awaiting meeting approval, push a transient system note so the model
   answers questions without re-triggering `check_meeting`.
2. Append the user turn to `convo`.
3. Call `callLLMWithFallback()`.
4. Strip `<think>…</think>` (reasoning models leak these).
5. If the reply is empty, substitute a language-matched apology.
6. Extract `<tool>{...}</tool>` via regex, execute it, strip it from spoken text.
7. `speak()` the remainder.

### Why regex tools instead of native function calling

The original Cloudflare models were unreliable at structured output, so the
prompt asks for a `<tool>` tag and the server parses it. Groq supports native
tool calling and migrating would be cleaner — but the current approach is
benchmarked at 10/10 and switching would invalidate that. Left as-is
deliberately.

### The two prompt bugs that shaped the current prompt

Both were found by `bench/run-llm.js` and are documented at length in
`lib/system-prompt.js`:

1. **Language drift.** Listing Arabic first + an "Egyptian receptionist" persona
   overrode the reply-language rule; English visitors got Arabic answers (3/3
   reproducible). Fixed by making language selection the *first* rule and
   *mechanical* ("look at the script of the user's last message").

2. **Placeholder tool calls.** Banning specific strings (`John Doe`, `Unknown`)
   taught the model to invent *other* filler — it emitted `check_meeting` with
   literal `"?"` for uncollected fields, which would have written junk records.
   Fixed by stating a precondition instead of a blocklist.

**Do not "simplify" the LANGUAGE or TOOLS sections without re-running the
benchmark.** Both encode a fix for a bug that reached production.

---

## 5. Provider layer (`lib/providers.js`)

One module owns backend selection so switching is an `.env` change.

```
LLM_PROVIDER=groq          # groq | cerebras | gemini | openrouter | cloudflare
LLM_FALLBACKS=cloudflare   # tried in order when the primary fails
STT_PROVIDER=groq
TTS_PROVIDER=elevenlabs    # elevenlabs | local
```

`callLLMWithFallback()` walks the chain on any error. This matters because free
tiers throttle without warning — Groq's **100 000 tokens/day** cap is reached
after roughly 40–60 conversations, and without a fallback the visitor simply
hears nothing.

`providerStatus()` powers `GET /config`, which reports what each layer resolved
to without exposing key material. It is the fastest way to diagnose a bad deploy.

---

## 6. Prompt sizing

The system prompt is resent on **every** turn, so its size directly sets how many
turns fit in the rate limit.

| Variant | Tokens | Benchmark | Turns/min @ 12k TPM |
|---|---|---|---|
| `KB_MODE=full` | ~2 516 | 10/10 | ~4 |
| **`KB_MODE=lean`** (default) | **~1 673** | **10/10** | **~7** |
| without STYLE section | ~2 361 | **FAIL** | — |

The saving is entirely in the knowledge base: `db.json`'s `company_info` was 55 %
of the prompt, and `key_contacts` alone was 2 023 characters because it embedded
each person's full LinkedIn work history.

Dropping the STYLE section instead **broke brevity** — a reminder that the
behaviour rules earn their tokens and the data did not.

---

## 7. Data model (`db.json`)

| Key | Purpose |
|---|---|
| `company_info` | Knowledge base injected into the prompt |
| `customers` | Captured leads (`save_lead`) |
| `meetings` | Expected visitors, matched by `check_meeting` |
| `inquiries` | Logged questions |
| `counters` | ID sequences |

Meeting matching uses hybrid fuzzy comparison (Levenshtein + trigram cosine,
`isSimilar()`), because names arrive transliterated and inconsistently spelled —
"Ahmed Sadek" must match "ahmed sadek el sewedy".

`db.sql` holds a Postgres schema for a future migration; nothing uses it yet.

---

## 8. Repository layout

```
server.js                 Express + WebSocket server, turn handling, TTS
lib/providers.js          LLM/STT backend selection + fallback chain
lib/system-prompt.js      System prompt (single source of truth)
public/client.html        Browser UI, mic capture, VAD, PCM playback
scripts/doctor.js         Preflight check — run this first on a new machine
bench/                    Benchmark harnesses (see bench/README.md)
tts-server/               Self-hosted TTS sidecar (Python, needs a GPU)
legacy/                   Dead Twilio/Azure/Google code, NOT loaded
docs/                     This file
db.json                   Knowledge base + captured data
```

---

## 9. Known limitations

- **No barge-in.** A half-duplex `isSpeaking` flag *discards* visitor input while
  Geno talks, rather than interrupting playback. Fixing this properly means
  cancelling the audio queue on speech detection.
- **STT unverified on real lobby audio.** Measured only on clean synthesized
  speech (~10 % WER). Needs a recorded golden set — see `bench/README.md`.
- **TTS is the last paid component.** Everything else runs on free tiers.
- **Conversation history grows unbounded** within a session; a long conversation
  will eventually hit the token cap. Trimming old turns is the next lever.
