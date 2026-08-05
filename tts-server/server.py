"""
Self-hosted TTS sidecar for Geno.

Serves NAMAA-Egyptian-TTS (Arabic) and Chatterbox Multilingual (English) behind
one HTTP endpoint that matches the contract expected by server.js's speakLocal().

Both models are MIT-licensed and share the Chatterbox architecture, so they load
through the same code path -- only the checkpoint differs.

    POST /synthesize   {"text": "...", "language": "ar"|"en", "sample_rate": 24000}
    -> audio/wav (16-bit mono PCM at sample_rate)

    GET  /health       -> {"ok": true, "device": "cuda", "models_loaded": [...]}

Requires ~8GB VRAM with both models resident. On a smaller card set
TTS_LAZY_UNLOAD=1 to keep only one model in memory at a time (slower on
language switches, but fits in ~4GB).

Run:
    pip install -r requirements.txt
    python server.py                  # listens on :8020
"""

import io
import os
import sys
import time
import wave
import logging
from threading import Lock

import numpy as np
from flask import Flask, request, jsonify, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s [tts] %(message)s")
log = logging.getLogger("tts")

PORT = int(os.environ.get("TTS_PORT", "8020"))
LAZY_UNLOAD = os.environ.get("TTS_LAZY_UNLOAD", "0") == "1"
AR_MODEL = os.environ.get("TTS_AR_MODEL", "NAMAA-Space/NAMAA-Egyptian-TTS")
EN_MODEL = os.environ.get("TTS_EN_MODEL", "ResembleAI/chatterbox")
# Optional reference clip for zero-shot voice cloning, so Arabic and English
# share one consistent "Geno" voice instead of two unrelated ones.
AR_VOICE_REF = os.environ.get("TTS_AR_VOICE_REF", "")
EN_VOICE_REF = os.environ.get("TTS_EN_VOICE_REF", "")

app = Flask(__name__)
_models = {}
_lock = Lock()  # models are not thread-safe; serialize synthesis


def _device():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


DEVICE = _device()


def _load(language):
    """Load (and cache) the model for a language."""
    if language in _models:
        return _models[language]

    from chatterbox.tts import ChatterboxMultilingualTTS

    repo = AR_MODEL if language == "ar" else EN_MODEL
    log.info("loading %s model %s on %s ...", language, repo, DEVICE)
    t0 = time.time()
    model = ChatterboxMultilingualTTS.from_pretrained(repo, device=DEVICE)
    log.info("loaded %s in %.1fs", language, time.time() - t0)

    if LAZY_UNLOAD:
        # Keep only one model resident on small cards.
        for other in list(_models):
            if other != language:
                log.info("unloading %s to free VRAM", other)
                del _models[other]
        try:
            import torch, gc
            gc.collect()
            torch.cuda.empty_cache()
        except Exception:
            pass

    _models[language] = model
    return model


def _to_wav(audio, sample_rate):
    """float32/int16 numpy or torch tensor -> 16-bit mono WAV bytes."""
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = np.asarray(audio).squeeze()
    if audio.ndim > 1:
        audio = audio[0]

    if audio.dtype != np.int16:
        peak = float(np.max(np.abs(audio))) or 1.0
        # Normalize only if clipping; otherwise preserve the model's own level.
        if peak > 1.0:
            audio = audio / peak
        audio = np.clip(audio * 32767.0, -32768, 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(audio.tobytes())
    return buf.getvalue()


def _resample(audio, src_rate, dst_rate):
    """Linear resample. Adequate for speech; swap for soxr if quality matters."""
    if src_rate == dst_rate:
        return audio
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = np.asarray(audio).squeeze()
    n_out = int(len(audio) * dst_rate / src_rate)
    return np.interp(
        np.linspace(0, len(audio) - 1, n_out),
        np.arange(len(audio)),
        audio,
    )


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "device": DEVICE,
        "models_loaded": sorted(_models.keys()),
        "lazy_unload": LAZY_UNLOAD,
        "ar_model": AR_MODEL,
        "en_model": EN_MODEL,
    })


@app.post("/synthesize")
def synthesize():
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    language = (body.get("language") or "ar").lower()
    target_rate = int(body.get("sample_rate") or 24000)

    if not text:
        return jsonify({"ok": False, "error": "empty text"}), 400
    if language not in ("ar", "en"):
        return jsonify({"ok": False, "error": f"unsupported language '{language}'"}), 400

    t0 = time.time()
    try:
        with _lock:
            model = _load(language)
            ref = AR_VOICE_REF if language == "ar" else EN_VOICE_REF
            kwargs = {"language_id": language}
            if ref and os.path.exists(ref):
                kwargs["audio_prompt_path"] = ref
            wav = model.generate(text, **kwargs)

        native_rate = int(getattr(model, "sr", 24000))
        if native_rate != target_rate:
            wav = _resample(wav, native_rate, target_rate)

        data = _to_wav(wav, target_rate)
        log.info("%s %dch %.2fs audio in %.0fms: %s",
                 language, 1, (len(data) - 44) / 2 / target_rate,
                 (time.time() - t0) * 1000, text[:60])
        return Response(data, mimetype="audio/wav")
    except Exception as e:
        log.exception("synthesis failed")
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    log.info("device=%s  lazy_unload=%s", DEVICE, LAZY_UNLOAD)
    if DEVICE == "cpu":
        log.warning("running on CPU - synthesis will be far too slow for live use")
    if os.environ.get("TTS_PRELOAD", "1") == "1":
        # Load Arabic up front so the first visitor does not wait for a cold model.
        try:
            _load("ar")
        except Exception:
            log.exception("preload failed; will retry on first request")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
