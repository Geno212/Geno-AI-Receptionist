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
# Pacing is controlled by classifier-free guidance, the model's own knob:
# lower cfg_weight = slower, more deliberate prosody (0.3 is the value the
# Chatterbox authors recommend for fast-sounding voices). Post-processing the
# waveform with a phase vocoder was tried instead and sounded robotic.
CFG_WEIGHT = float(os.environ.get("TTS_CFG_WEIGHT", "0.3"))
# Higher exaggeration speeds speech up, so keep it at the neutral default.
EXAGGERATION = float(os.environ.get("TTS_EXAGGERATION", "0.5"))
TEMPERATURE = float(os.environ.get("TTS_TEMPERATURE", "0.8"))

app = Flask(__name__)
_models = {}
_lock = Lock()  # models are not thread-safe; serialize synthesis

# Chatterbox Multilingual language ids. "ar" uses the NAMAA Egyptian T3 overlay;
# every other language shares one base multilingual checkpoint ("mtl" cache slot).
SUPPORTED_LANGS = {
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko",
    "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
}
# Only Arabic + English are enabled at boot. Other languages are added via
# POST /ensure when the Node STT layer detects them.
CORE_LANGS = {"ar", "en"}
_enabled = set(CORE_LANGS)


def _slot(language):
    """VRAM cache key: Egyptian Arabic is its own slot; all others share mtl."""
    return "ar" if language == "ar" else "mtl"


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


def _cuda_gc(reason=""):
    """Drop Python refs and return cached CUDA blocks to the allocator."""
    import gc
    gc.collect()
    if DEVICE != "cuda":
        return
    try:
        import torch
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        # ipc_collect helps after large tensor deletes on Windows.
        if hasattr(torch.cuda, "ipc_collect"):
            torch.cuda.ipc_collect()
        freed = ""
        if reason:
            used = torch.cuda.memory_allocated() / (1024 ** 2)
            reserved = torch.cuda.memory_reserved() / (1024 ** 2)
            freed = f"  allocated={used:.0f}MiB reserved={reserved:.0f}MiB"
        log.info("cuda gc%s%s", f" ({reason})" if reason else "", freed)
    except Exception:
        log.exception("cuda gc failed")


def _unload_language(language):
    """Fully drop a cached language model and free its VRAM."""
    model = _models.pop(language, None)
    if model is None:
        return False
    log.info("unloading %s to free VRAM", language)
    try:
        # Move modules off GPU before dropping refs so CUDA can reclaim sooner.
        for attr in ("t3", "s3gen", "ve"):
            mod = getattr(model, attr, None)
            if mod is not None and hasattr(mod, "to"):
                try:
                    mod.to("cpu")
                except Exception:
                    pass
        if getattr(model, "conds", None) is not None:
            try:
                model.conds = None
            except Exception:
                pass
    finally:
        del model
        _cuda_gc(f"unload {language}")
    return True


def _load(language):
    """Load (and cache) the model slot for a language.

    Slots:
      ar  — base multilingual + NAMAA Egyptian T3 overlay
      mtl — base multilingual for en and every other supported language
    """
    if language not in SUPPORTED_LANGS:
        raise ValueError(f"unsupported language '{language}'")

    slot = _slot(language)
    if slot in _models:
        return _models[slot]

    from chatterbox import ChatterboxMultilingualTTS
    from huggingface_hub import snapshot_download
    from safetensors.torch import load_file as load_safetensors

    # Unload the OTHER slot FIRST so ar and mtl never share VRAM on 4 GB cards.
    if LAZY_UNLOAD:
        for other in list(_models):
            if other != slot:
                _unload_language(other)

    repo = AR_MODEL if slot == "ar" else EN_MODEL
    log.info("loading slot=%s for language=%s model=%s on %s ...",
             slot, language, repo, DEVICE)
    t0 = time.time()
    model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)

    if slot == "ar" and AR_MODEL:
        ckpt_dir = snapshot_download(repo_id=AR_MODEL, repo_type="model", revision="main")
        t3_path = os.path.join(ckpt_dir, "t3_mtl23ls_v2.safetensors")
        if os.path.isfile(t3_path):
            t3_state = load_safetensors(t3_path, device=DEVICE)
            model.t3.load_state_dict(t3_state)
            model.t3.to(DEVICE).eval()
            log.info("applied Egyptian T3 weights from %s", AR_MODEL)
            del t3_state
            _cuda_gc("after namaa overlay")
        else:
            log.warning("no t3_mtl23ls_v2.safetensors in %s; using base multilingual Arabic", ckpt_dir)

    # Memory vs quality: the T3 transformer is stable in half precision, but the
    # S3Gen vocoder must stay float32. Half-precision vocoder residuals produce
    # buzzing / robotic artifacts. On 4 GB cards prefer TTS_LAZY_UNLOAD=1 over
    # forcing the vocoder into fp16.
    if DEVICE == "cuda" and os.environ.get("TTS_FP16", "1") == "1":
        try:
            import torch
            model.t3 = model.t3.half()
            if model.conds is not None:
                for name in dir(model.conds):
                    if name.startswith("_"):
                        continue
                    val = getattr(model.conds, name, None)
                    if torch.is_tensor(val) and val.is_floating_point():
                        setattr(model.conds, name, val.half())
                    elif hasattr(val, "__dict__"):
                        for k, v in list(vars(val).items()):
                            if torch.is_tensor(v) and v.is_floating_point():
                                setattr(val, k, v.half())
            torch.cuda.empty_cache()
            log.info("t3→fp16, s3gen/ve left fp32 (vocoder quality)")
        except Exception:
            log.exception("fp16 conversion failed; continuing in fp32")

    log.info("loaded slot=%s in %.1fs", slot, time.time() - t0)
    _models[slot] = model
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
    info = {
        "ok": True,
        "device": DEVICE,
        "models_loaded": sorted(_models.keys()),
        "lazy_unload": LAZY_UNLOAD,
        "cfg_weight": CFG_WEIGHT,
        "exaggeration": EXAGGERATION,
        "ar_model": AR_MODEL,
        "en_model": EN_MODEL,
        "core_languages": sorted(CORE_LANGS),
        "enabled_languages": sorted(_enabled),
        "supported_languages": sorted(SUPPORTED_LANGS),
    }
    if DEVICE == "cuda":
        try:
            import torch
            info["cuda_allocated_mib"] = round(torch.cuda.memory_allocated() / (1024 ** 2))
            info["cuda_reserved_mib"] = round(torch.cuda.memory_reserved() / (1024 ** 2))
        except Exception:
            pass
    return jsonify(info)


@app.post("/ensure")
def ensure():
    """Enable a language for synthesis. Body: {"language":"fr"}.

    Core langs (ar, en) are always enabled. Others are added when Node STT
    detects them so we do not advertise every Chatterbox language up front.
    Loading the mtl slot still happens lazily on first synthesize.
    """
    body = request.get_json(silent=True) or {}
    language = (body.get("language") or "").lower().strip()
    if language not in SUPPORTED_LANGS:
        return jsonify({
            "ok": False,
            "error": f"unsupported language '{language}'",
            "supported": sorted(SUPPORTED_LANGS),
        }), 400
    newly = language not in _enabled
    _enabled.add(language)
    log.info("ensure language=%s newly=%s enabled=%s", language, newly, sorted(_enabled))
    return jsonify({
        "ok": True,
        "language": language,
        "newly_enabled": newly,
        "slot": _slot(language),
        "enabled_languages": sorted(_enabled),
        "models_loaded": sorted(_models.keys()),
    })


@app.post("/unload")
def unload():
    """Drop cached models and run CUDA GC. Body: {"language":"ar"|"mtl"|"en"|"all"}."""
    body = request.get_json(silent=True) or {}
    target = (body.get("language") or "all").lower()
    if target == "en":
        target = "mtl"
    dropped = []
    if target == "all":
        for lang in list(_models):
            if _unload_language(lang):
                dropped.append(lang)
    elif target in ("ar", "mtl"):
        if _unload_language(target):
            dropped.append(target)
    elif target in SUPPORTED_LANGS:
        slot = _slot(target)
        if _unload_language(slot):
            dropped.append(slot)
    else:
        return jsonify({"ok": False, "error": f"unsupported language '{target}'"}), 400
    _cuda_gc("manual unload")
    return jsonify({
        "ok": True,
        "unloaded": dropped,
        "models_loaded": sorted(_models.keys()),
    })


@app.post("/gc")
def gc_endpoint():
    """Force Python + CUDA cache cleanup without unloading models."""
    _cuda_gc("manual gc")
    return health()


@app.post("/synthesize")
def synthesize():
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    language = (body.get("language") or "ar").lower()
    target_rate = int(body.get("sample_rate") or 24000)

    if not text:
        return jsonify({"ok": False, "error": "empty text"}), 400
    if language not in SUPPORTED_LANGS:
        return jsonify({
            "ok": False,
            "error": f"unsupported language '{language}'",
            "supported": sorted(SUPPORTED_LANGS),
        }), 400
    if language not in _enabled:
        return jsonify({
            "ok": False,
            "error": f"language '{language}' is not enabled yet; POST /ensure first",
            "enabled_languages": sorted(_enabled),
            "core_languages": sorted(CORE_LANGS),
        }), 409

    t0 = time.time()
    try:
        with _lock:
            model = _load(language)
            ref = AR_VOICE_REF if language == "ar" else EN_VOICE_REF
            kwargs = {
                "language_id": language,
                "cfg_weight": float(body.get("cfg_weight") or CFG_WEIGHT),
                "exaggeration": float(body.get("exaggeration") or EXAGGERATION),
                "temperature": float(body.get("temperature") or TEMPERATURE),
            }
            if ref and os.path.exists(ref):
                kwargs["audio_prompt_path"] = ref
            # Do not wrap generate() in autocast: that would also cast S3Gen
            # (vocoder) math to fp16 and reintroduce robotic artifacts.
            wav = model.generate(text, **kwargs)

        native_rate = int(getattr(model, "sr", 24000))
        if native_rate != target_rate:
            wav = _resample(wav, native_rate, target_rate)

        data = _to_wav(wav, target_rate)
        log.info("%s %dch %.2fs audio (cfg=%.2f) in %.0fms: %s",
                 language, 1, (len(data) - 44) / 2 / target_rate, kwargs["cfg_weight"],
                 (time.time() - t0) * 1000, text[:60])
        return Response(data, mimetype="audio/wav")
    except Exception as e:
        log.exception("synthesis failed")
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    log.info("device=%s  lazy_unload=%s  cfg_weight=%.2f  exaggeration=%.2f",
             DEVICE, LAZY_UNLOAD, CFG_WEIGHT, EXAGGERATION)
    if DEVICE == "cpu":
        log.warning("running on CPU - synthesis will be far too slow for live use")
    if os.environ.get("TTS_PRELOAD", "1") == "1":
        # Load Arabic up front so the first visitor does not wait for a cold model.
        try:
            _load("ar")
        except Exception:
            log.exception("preload failed; will retry on first request")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
