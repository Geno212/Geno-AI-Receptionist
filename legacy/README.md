# Legacy code — not loaded by the application

Reference only. Nothing here is imported, executed, or required to run Geno.

## Contents

**`server-legacy-code.js`** — 462 lines of commented-out implementation
extracted from `server.js` on 2026-07-29:

- **Twilio Media Streams** — bidirectional μ-law telephony over WebSocket,
  TwiML webhook handlers, μ-law encode/decode tables
- **Azure Speech** — STT push-stream recognition, TTS with SSML building, voice
  fallback chains, μ-law output formats
- **Google Cloud Speech** — references from the original project scaffold

## Why it was removed

`server.js` was 1 544 lines, of which ~460 were dead comments interleaved with
live code. Reading the actual request flow meant scrolling past three abandoned
implementations. Extracting them cut the file to ~1 080 lines without changing
any behaviour — verified by re-running the full endpoint smoke test before and
after.

## If telephony is ever revived

Do **not** restore this verbatim. It predates:

- the provider abstraction (`lib/providers.js`)
- the shared prompt module (`lib/system-prompt.js`) and its two benchmarked bug
  fixes
- the PCM/`tts_end` client audio contract

Rebuild on the current architecture instead, adding a telephony provider
alongside the browser path. See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

The `.env.example` in the repository root no longer carries Twilio/Azure keys.
Historical values are in git history if needed.
