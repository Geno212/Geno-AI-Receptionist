// TTS providers, all normalized to the client's raw-PCM contract.
//
// The client (public/client.html) plays raw PCM 24kHz 16-bit mono LE frames and
// ends an utterance on a {type:'tts_end'} JSON message. See server.js:1366-1373.
// Every provider here returns PCM in that shape (resampling if its native rate
// differs) so a swap never touches client code.
//
// Candidates, Egyptian Arabic + English only:
//   NAMAA-Egyptian-TTS  (MIT)  - Egyptian dialect, 0.5B, Chatterbox architecture
//   Chatterbox Multilingual (MIT) - English, same architecture => one code path
//   ElevenLabs - incumbent, paid, kept as the quality bar to beat
//
// NOTE: neither open model is natively streaming; they synthesize a full
// utterance. TTFB therefore equals full synthesis time, which is the number
// that decides whether the agent feels responsive. Measure it honestly.

const { ProviderError, MissingCredentialsError, QuotaError, isQuotaStatus, resamplePcm16, CLIENT_AUDIO_CONTRACT } = require("./interface");

const TARGET_RATE = CLIENT_AUDIO_CONTRACT.sampleRate; // 24000

const providers = {
  /**
   * Incumbent. Streams raw PCM 24kHz directly -- already contract-native.
   * Present so every open candidate is scored against the current quality bar.
   */
  elevenlabs: {
    label: "ElevenLabs (incumbent, paid)",
    kind: "hosted",
    license: "proprietary",
    cost: "paid",
    envVars: ["ELEVENLABS_API_KEY"],
    defaultModel: "eleven_multilingual_v2",
    async synthesize({ text, model, params = {} }) {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) throw new MissingCredentialsError("elevenlabs", ["ELEVENLABS_API_KEY"]);
      const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
      const latency = process.env.ELEVENLABS_LATENCY || "1";

      const started = Date.now();
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=${latency}&output_format=pcm_24000`,
        {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: model,
            voice_settings: {
              stability: parseFloat(process.env.ELEVENLABS_STABILITY || "0.5"),
              similarity_boost: parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || "0.75"),
            },
            ...params,
          }),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (isQuotaStatus(res.status)) throw new QuotaError("elevenlabs", detail.slice(0, 300), res.status);
        throw new ProviderError("elevenlabs", `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
      }

      // Measure true TTFB: time until the first audio byte lands.
      const reader = res.body.getReader();
      const chunks = [];
      let ttfbMs = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttfbMs === null && value?.length) ttfbMs = Date.now() - started;
        chunks.push(Buffer.from(value));
      }
      const pcm = Buffer.concat(chunks);
      return {
        pcm,
        sampleRate: 24000,
        latencyMs: Date.now() - started,
        ttfbMs: ttfbMs ?? Date.now() - started,
        meta: { provider: "elevenlabs", model, params, resampled: false },
      };
    },
  },

  /**
   * Self-hosted NAMAA-Egyptian-TTS / Chatterbox Multilingual behind a small
   * local HTTP server (see bench/local-tts-server/README.md).
   * Cannot run on this machine (MX350, 2GB VRAM); wired for El Sewedy's GPU box.
   *
   * Expected response: WAV or raw PCM16. Native rate is read from the WAV
   * header and resampled to 24kHz if needed -- NAMAA emits at model.sr, which
   * must be verified rather than assumed.
   */
  namaa: {
    label: "NAMAA-Egyptian-TTS (self-hosted)",
    kind: "local",
    license: "MIT",
    cost: "free",
    envVars: ["TTS_LOCAL_URL"],
    defaultModel: "namaa-egyptian-tts",
    async synthesize({ text, model, params = {} }) {
      const base = process.env.TTS_LOCAL_URL;
      if (!base) throw new MissingCredentialsError("namaa", ["TTS_LOCAL_URL"]);

      const started = Date.now();
      const res = await fetch(`${base.replace(/\/$/, "")}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model, ...params }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ProviderError("namaa", `HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
      }
      const raw = Buffer.from(await res.arrayBuffer());
      const latencyMs = Date.now() - started;

      const { pcm, sampleRate } = decodeAudio(raw);
      const resampled = sampleRate !== TARGET_RATE;
      return {
        pcm: resampled ? resamplePcm16(pcm, sampleRate, TARGET_RATE) : pcm,
        sampleRate,
        latencyMs,
        ttfbMs: latencyMs, // non-streaming: first byte == last byte
        meta: { provider: "namaa", model, params, resampled },
      };
    },
  },
};

/** Accept WAV (parse header) or assume raw PCM16 at 24kHz. */
function decodeAudio(buf) {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    const channels = buf.readUInt16LE(22);
    if (bitsPerSample !== 16) {
      throw new ProviderError("tts", `expected 16-bit PCM, got ${bitsPerSample}-bit`);
    }
    if (channels !== 1) {
      throw new ProviderError("tts", `expected mono, got ${channels} channels`);
    }
    // Walk chunks to find 'data' rather than assuming offset 44.
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "data") return { pcm: buf.subarray(off + 8, off + 8 + size), sampleRate };
      off += 8 + size + (size % 2);
    }
    throw new ProviderError("tts", "WAV had no data chunk");
  }
  return { pcm: buf, sampleRate: TARGET_RATE };
}

/** Audio sanity checks -- catches silence, clipping and wrong-rate output. */
function analyzePcm(pcm, sampleRate) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { durationSec: 0, rms: 0, peak: 0, clippedPct: 0, silent: true };
  let sumSq = 0, peak = 0, clipped = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 32700) clipped++;
  }
  const rms = Math.sqrt(sumSq / samples);
  return {
    durationSec: samples / sampleRate,
    rms: Math.round(rms),
    peak,
    clippedPct: +((clipped / samples) * 100).toFixed(2),
    silent: rms < 50,
  };
}

function available() {
  return Object.entries(providers)
    .filter(([, p]) => p.envVars.every((v) => process.env[v]))
    .map(([k]) => k);
}

async function synthesize(providerKey, opts) {
  const p = providers[providerKey];
  if (!p) throw new Error(`unknown TTS provider "${providerKey}" (have: ${Object.keys(providers).join(", ")})`);
  return p.synthesize({ ...opts, model: opts.model || p.defaultModel });
}

module.exports = { providers, available, synthesize, analyzePcm, decodeAudio, TARGET_RATE };
