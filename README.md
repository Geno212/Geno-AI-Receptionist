# Geno — El Sewedy Electric AI Receptionist

Browser-based bilingual (Egyptian Arabic + English) AI receptionist. Handles
visitor meeting verification and sales lead capture.

**Stack as of 2026-07-29** — migrated off the paid Cloudflare/Azure stack:

| Layer | Provider | Model | Cost |
|---|---|---|---|
| LLM | Groq | `llama-3.3-70b-versatile` | **free tier** |
| STT | Groq | `whisper-large-v3` | **free tier** |
| TTS | ElevenLabs | `eleven_multilingual_v2` | **paid — the only remaining cost** |

Provider choice is `.env` configuration, not code — see [lib/providers.js](lib/providers.js).

> **New to this project, or setting it up on another machine?**
> Read **[docs/HANDOVER.md](docs/HANDOVER.md)** — the complete guide: current
> status, the full request flow, usage caps, exact setup steps, and how to switch
> to the fully free stack.

## Quick start

```bash
npm install
cp .env.example .env     # then fill in the keys below
npm run doctor           # verifies EVERYTHING before you start
npm start                # http://localhost:3000
```

Open `http://localhost:3000`, click **Call**, and speak.

**Always run `npm run doctor` first on a new machine.** It checks the Node
version, dependencies, `.env`, every provider credential, and makes one live
call to each API — then prints an exact fix for anything broken. Use
`npm run doctor:quick` to skip the live calls (offline, or to preserve quota).

### Required keys

```bash
GROQ_API_KEY=gsk_...        # https://console.groq.com/keys  — covers BOTH llm + stt
ELEVENLABS_API_KEY=sk_...   # https://elevenlabs.io          — TTS only
```

Optional fallback (recommended for production — free tiers throttle without warning):

```bash
LLM_FALLBACKS=cloudflare
CF_ACCOUNT_ID=...
CF_API_TOKEN=...
```

### Verifying a deployment

```bash
curl localhost:3000/health     # {"ok":true}
curl localhost:3000/config     # which provider each layer resolved to (no secrets)
```

`/config` is the fastest way to catch a misconfigured `.env` — it reports
`configured: false` for any layer missing credentials.

## Architecture

```
Browser (src/client)
  mic → MediaRecorder + volume VAD
     ↓ POST /stt  (audio blob)
  Server → Groq Whisper → transcript
     ↓ WebSocket /client-ws  {type:"text"}
  Server → Groq LLM (lib/system-prompt.js) → reply + <tool> tags
     ↓ tool calls → db.json (leads, meetings)
     ↓ ElevenLabs → raw PCM 24kHz frames → {type:"tts_end"}
  Browser → Web Audio API playback
```

**Audio contract:** TTS streams raw **PCM 24 kHz, 16-bit, mono, little-endian**
binary frames over the WebSocket, terminated by a `{"type":"tts_end"}` JSON
message. Any TTS provider honoring this drops in without client changes.

### STT modes

`STT_SERVER_SIDE=1` (default) records the utterance in-browser and posts it to
`/stt` for Groq Whisper. This works in **any** browser and handles Egyptian
dialect well.

Set `STT_SERVER_SIDE=0` to use the browser's Web Speech API instead (Chrome-only,
weaker on dialect, but zero server cost). The client also falls back to it
automatically if `/stt` fails or `MediaRecorder` is unavailable — a speech-service
outage degrades gracefully instead of leaving a dead microphone.

### Prompt

`lib/system-prompt.js` is the single source of truth, shared by the server and
the benchmark so they cannot drift.

`KB_MODE=lean` (default) trims `db.json`'s `company_info` — mainly the embedded
LinkedIn work histories in `key_contacts` — for **34% fewer tokens at the same
benchmark score**. `KB_MODE=full` sends everything.

## Costs

### Measured free-tier limits (Groq, verified 2026-07-29)

| Limit | Value | What it means here |
|---|---|---|
| Tokens/minute | 12,000 | ~7 conversation turns/min with the lean prompt |
| **Tokens/day** | **100,000** | the real ceiling — ~4 full benchmark runs |
| Requests/day | 1,000 | ample for a reception desk |
| Whisper STT | 2,000 req/day, 28,800 audio-sec/day | ~8 hours of speech daily |

A reception desk seeing 50–200 conversations/day at ~6 turns each needs roughly
300–1,200 LLM calls — within the request quota, but the **100k tokens/day cap is
the binding constraint**. At ~1,673 prompt tokens/turn plus history, that is
roughly **40–60 conversations/day** before throttling. Beyond that you need
either the fallback provider, further prompt trimming, or Groq's paid tier.

### Old vs new, per month

| Layer | Before | After | Saving |
|---|---|---|---|
| LLM | Cloudflare Workers AI (paid neurons) | Groq free | ~100% |
| STT | Browser Web Speech (free but Chrome-only) | Groq Whisper free | — (quality gain) |
| TTS | ElevenLabs ~$22–99/mo | ElevenLabs ~$22–99/mo | **unchanged** |

**Honest summary: LLM and STT are now free; TTS is not.** ElevenLabs remains the
single line item, so the migration removes most of the bill but not all of it.
"Nearly free" is accurate only if TTS is also replaced.

### Eliminating the last cost

TTS can go to zero with a self-hosted MIT-licensed model — **NAMAA-Egyptian-TTS**
(Egyptian dialect) or **Chatterbox Multilingual** (English). Both need a real GPU
(~8 GB VRAM); a one-time RTX 4090-class card (~$1,600–2,000) or ~$150–300/mo
cloud GPU replaces the ElevenLabs subscription permanently and keeps visitor
audio in-house.

Not yet done: no one has listened to the free Egyptian TTS output to confirm it
meets El Sewedy's quality bar. That is a judgment call, not a benchmark.

## Running on a machine with a GPU

An 8 GB GPU eliminates the last paid component. Start the TTS sidecar:

```bash
cd tts-server
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
python server.py                 # :8020
```

Then switch the Node server over:

```bash
# .env
TTS_PROVIDER=local
TTS_LOCAL_URL=http://localhost:8020
```

`npm run doctor` will confirm the sidecar is reachable and report whether it is
on CUDA or (too slow) CPU. Full details: [tts-server/README.md](tts-server/README.md).

## Testing

```bash
node bench/run-llm.js            # 10 receptionist behaviour cases
node bench/run-prompt-size.js    # prompt token cost vs. pass rate
node bench/run-tts.js --lang ar  # writes playable WAVs to bench/out/audio/
node bench/run-stt.js            # needs a recorded golden set
```

See [bench/README.md](bench/README.md) for what each harness checks, the
benchmark results, and how to record the STT golden set.

## Documentation

| Document | Contents |
|---|---|
| **[docs/HANDOVER.md](docs/HANDOVER.md)** | **Start here** — status, full flow, caps, setup, free-stack switch |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical detail on the request flow and audio contract |
| [bench/README.md](bench/README.md) | Benchmark harnesses and measured results |
| [tts-server/README.md](tts-server/README.md) | Self-hosted TTS setup |
| [legacy/README.md](legacy/README.md) | The removed Twilio/Azure/Google code |

## Data

`db.json` — company knowledge base, captured leads, and meeting records.
`db.sql` — schema for a future Postgres migration.

## Known gaps

- **STT is untested on real lobby audio.** Verified only on clean TTS-generated
  speech (~10% WER). Needs 15–30 real recordings — see bench/README.md.
- **TTS quality unverified** for the free Egyptian models.
- **No barge-in.** A half-duplex `isSpeaking` flag discards visitor input while
  Geno is talking.
- **Conversation history grows unbounded** within a session, so a very long
  conversation can approach the token cap. Trimming old turns is the next lever.

Legacy Twilio / Azure Speech / Google Cloud code was moved to [legacy/](legacy/)
on 2026-07-29 and is no longer loaded.
