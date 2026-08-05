# Self-hosted TTS sidecar

Replaces ElevenLabs — the **last paid component** — with MIT-licensed models
running on your own GPU.

| Language | Model | License |
|---|---|---|
| Egyptian Arabic | [NAMAA-Egyptian-TTS](https://huggingface.co/NAMAA-Space/NAMAA-Egyptian-TTS) | MIT |
| English | [Chatterbox Multilingual](https://huggingface.co/ResembleAI/chatterbox) | MIT |

Both share the Chatterbox architecture, so one code path serves both.

## Requirements

- **NVIDIA GPU with ≥8 GB VRAM** (both models resident). With 4–6 GB set
  `TTS_LAZY_UNLOAD=1` to keep one model loaded at a time.
- Python 3.10+
- CUDA-matched PyTorch

CPU technically runs but is far too slow for live conversation.

## Install

```bash
cd tts-server

# 1. PyTorch FIRST, matched to your CUDA version (check with: nvidia-smi)
pip install torch --index-url https://download.pytorch.org/whl/cu121

# 2. Everything else
pip install -r requirements.txt
```

First run downloads ~2–3 GB of weights from Hugging Face.

## Run

```bash
python server.py            # listens on :8020
```

Then point the Node server at it:

```bash
# .env
TTS_PROVIDER=local
TTS_LOCAL_URL=http://localhost:8020
```

Verify:

```bash
curl localhost:8020/health
node scripts/doctor.js      # reports device + loaded models
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TTS_PORT` | `8020` | Listen port |
| `TTS_LAZY_UNLOAD` | `0` | Keep only one model in VRAM (for <8 GB cards) |
| `TTS_PRELOAD` | `1` | Load Arabic at startup so the first visitor doesn't wait |
| `TTS_AR_MODEL` | `NAMAA-Space/NAMAA-Egyptian-TTS` | Arabic checkpoint |
| `TTS_EN_MODEL` | `ResembleAI/chatterbox` | English checkpoint |
| `TTS_AR_VOICE_REF` | — | WAV path for zero-shot voice cloning (Arabic) |
| `TTS_EN_VOICE_REF` | — | WAV path for voice cloning (English) |

### Consistent voice across languages

By default Arabic and English use each model's built-in voice, so Geno sounds
like two different people. Point both `*_VOICE_REF` variables at the **same**
10-second reference clip to get one consistent voice in both languages.

## API

```
POST /synthesize
  {"text": "أهلاً بحضرتك", "language": "ar", "sample_rate": 24000}
  -> audio/wav  (16-bit mono PCM)

GET /health
  -> {"ok": true, "device": "cuda", "models_loaded": ["ar"]}
```

`server.js` strips the WAV header and forwards raw PCM frames, matching the
client contract in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Caveats

- **Not streaming.** These models synthesize a whole utterance, so the first
  audio byte arrives only when synthesis finishes. Expect higher time-to-first-
  byte than ElevenLabs, though total latency may still be lower on a fast GPU.
- **Synthesis is serialized** by a lock — the models are not thread-safe. One
  reception desk is fine; concurrent callers would queue.
- **Quality is unverified.** Nobody has yet listened to the Arabic output and
  confirmed it meets El Sewedy's bar. Generate samples with
  `node bench/run-tts.js --provider namaa --lang ar` and listen before switching
  production over.
