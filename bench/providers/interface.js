// Provider interface for the Geno OSS migration.
//
// Every STT/TTS/LLM implementation conforms to one of the shapes below so that
// swapping a free hosted API for a self-hosted model on El Sewedy's GPUs is a
// config change, not a rewrite.
//
// IMPORTANT (portability): identical weights do NOT guarantee identical output.
// Hosted endpoints apply their own decode defaults. Every implementation must
// therefore declare the decode params it used in `meta.params`, so the
// golden-set harness can diff hosted vs local and we can pin local settings to
// match. Never rely on a provider's defaults silently.

/**
 * @typedef {Object} SttResult
 * @property {string} text            Transcript.
 * @property {string} lang            Detected/assumed language tag (ar-EG | en-US).
 * @property {number} latencyMs       Wall-clock, request start -> full result.
 * @property {Object} meta            { provider, model, params, raw? }
 */

/**
 * @typedef {Object} TtsResult
 * @property {Buffer} pcm             Raw PCM. MUST be 16-bit mono little-endian.
 * @property {number} sampleRate      Native rate BEFORE any resampling.
 * @property {number} latencyMs       Request start -> first byte (see ttfbMs) / full.
 * @property {number} ttfbMs          Time to first audio byte. The number that
 *                                    actually determines perceived responsiveness.
 * @property {Object} meta            { provider, model, params, resampled }
 */

/**
 * @typedef {Object} LlmResult
 * @property {string} text            Assistant reply, tool tags included.
 * @property {number} latencyMs       Wall-clock to full completion.
 * @property {number} ttfbMs          Time to first token (streaming only, else = latencyMs).
 * @property {Object} meta            { provider, model, params, usage? }
 */

/**
 * The client (public/client.html) plays raw PCM 24kHz 16-bit mono frames and
 * treats a {type:'tts_end'} JSON message as the end-of-utterance sentinel.
 * Any TTS provider must ultimately deliver audio in this shape.
 * See server.js:1366-1373 for the existing ElevenLabs implementation.
 */
const CLIENT_AUDIO_CONTRACT = Object.freeze({
  sampleRate: 24000,
  bitDepth: 16,
  channels: 1,
  endian: "LE",
  endSentinel: { type: "tts_end" },
});

class ProviderError extends Error {
  constructor(provider, message, { status = null, cause = null } = {}) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.cause = cause;
  }
}

/** Thrown when a provider is selected but its credentials are missing. */
class MissingCredentialsError extends ProviderError {
  constructor(provider, envVars) {
    super(provider, `missing credentials: set ${envVars.join(" or ")} in .env`);
    this.name = "MissingCredentialsError";
    this.envVars = envVars;
  }
}

/** Thrown when a free tier rejects us for quota. Distinguished so the harness
 *  can report "quota exhausted" separately from "provider is broken". */
class QuotaError extends ProviderError {
  constructor(provider, message, status) {
    super(provider, `quota/rate limit: ${message}`, { status });
    this.name = "QuotaError";
  }
}

function isQuotaStatus(status) {
  return status === 429 || status === 402;
}

/**
 * Resample 16-bit mono PCM to a target rate using linear interpolation.
 * Adequate for speech benchmarking; if a provider's native rate ends up
 * mismatched in production, replace this with a windowed-sinc resampler
 * rather than shipping this one.
 */
function resamplePcm16(buf, fromRate, toRate) {
  if (fromRate === toRate) return buf;
  const inSamples = Math.floor(buf.length / 2);
  const ratio = toRate / fromRate;
  const outSamples = Math.floor(inSamples * ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = srcPos - i0;
    const s = buf.readInt16LE(i0 * 2) * (1 - frac) + buf.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

/** Wrap a 16-bit mono PCM buffer in a WAV header so results are playable. */
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = {
  CLIENT_AUDIO_CONTRACT,
  ProviderError,
  MissingCredentialsError,
  QuotaError,
  isQuotaStatus,
  resamplePcm16,
  pcmToWav,
};
