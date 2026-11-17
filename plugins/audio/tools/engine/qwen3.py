"""agentskilldeck Qwen3-TTS worker (mlx-audio on Apple Silicon).

Same protocol as synth.py: one JSON job on stdin, one JSON result per line on
stdout, progress as JSON lines {"progress": i, "total": n} on stderr. Each
model loads once per process.

  {"mode": "synth", "out_dir": "...", "items": [{id, text, speaker, instruct, describe?, lang, seed}]}
      -> {id, path, duration_s, sample_rate}   (mono 16-bit WAV at the model's rate,
                                                <out_dir>/<id>.t<seed>.wav; the bridge
                                                resamples to 44.1 kHz)
     speaker "design" uses the VoiceDesign model: the voice is `describe`,
     followed by the line's `instruct`.
  {"mode": "voices"}  -> {id, voice, model}
  {"mode": "warm", "design": false}  -> {id: "warm", model}   (loads the model(s) once)

Models: AGENTSKILLDECK_QWEN3_MODEL / AGENTSKILLDECK_QWEN3_DESIGN_MODEL override
the 8-bit mlx-community conversions below. Weights: Qwen3-TTS, Apache-2.0.
Runner: mlx-audio, MIT.
Exit codes: 0 ok, 1 bad job or engine failure, 2 packages not installed.
"""
import json
import os
import re
import sys
import traceback
import wave

sys.dont_write_bytecode = True

_proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

CUSTOM_MODEL = os.environ.get("AGENTSKILLDECK_QWEN3_MODEL") or "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
DESIGN_MODEL = os.environ.get("AGENTSKILLDECK_QWEN3_DESIGN_MODEL") or "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit"

# Script language codes -> Qwen3 language names. Anything else: auto.
LANGS = {
    "en": "english", "zh": "chinese", "de": "german", "it": "italian", "pt": "portuguese",
    "es": "spanish", "ja": "japanese", "ko": "korean", "fr": "french", "ru": "russian",
}


def emit(obj):
    _proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _proto.flush()


def progress(i, total):
    sys.stderr.write(json.dumps({"progress": i, "total": total}) + "\n")
    sys.stderr.flush()


def safe_name(item_id):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(item_id)).strip("._") or "item"


try:
    import numpy as np
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
except ImportError as e:
    sys.stderr.write(f"setup: {e}\n")
    sys.exit(2)


class Models:
    def __init__(self):
        self._m = {}

    def get(self, design):
        name = DESIGN_MODEL if design else CUSTOM_MODEL
        if name not in self._m:
            self._m[name] = load_model(name)
        return name, self._m[name]


def write_wav(path, audio, sr):
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def synth(models, job):
    items = job.get("items") or []
    out_dir = os.path.abspath(job.get("out_dir") or ".")
    os.makedirs(out_dir, exist_ok=True)
    for i, it in enumerate(items, 1):
        seed = int(it.get("seed") or 0)
        speaker = str(it.get("speaker") or "ryan")
        design = speaker == "design"
        _, model = models.get(design)
        instruct = str(it.get("instruct") or "").strip()
        if design:
            describe = str(it.get("describe") or "").strip().rstrip(".")
            instruct = f"{describe}. {instruct}".strip() if describe else instruct
        mx.random.seed(seed)  # sampling uses MLX's global RNG: seed = take
        kw = dict(text=str(it["text"]), instruct=instruct or None, lang_code=LANGS.get(it.get("lang") or "en", "auto"))
        if not design:
            kw["voice"] = speaker
        parts = [np.asarray(r.audio, dtype="float32").ravel() for r in model.generate(**kw)]
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype="float32")
        sr = int(model.sample_rate)
        path = os.path.join(out_dir, f"{safe_name(it['id'])}.t{seed}.wav")
        write_wav(path, audio, sr)
        emit({"id": it["id"], "path": path, "duration_s": round(len(audio) / sr, 4), "sample_rate": sr})
        progress(i, len(items))


def voices(models, job):
    name, model = models.get(False)
    for v in model.get_supported_speakers() or []:
        emit({"id": v, "voice": f"qwen:{v}", "model": name})


def warm(models, job):
    name, _ = models.get(False)
    emit({"id": "warm", "model": name})
    if job.get("design"):
        name, _ = models.get(True)
        emit({"id": "warm-design", "model": name})


MODES = {"synth": synth, "voices": voices, "warm": warm}


def main():
    try:
        job = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as e:
        sys.stderr.write(f"bad job JSON: {e}\n")
        return 1
    fn = MODES.get(job.get("mode"))
    if fn is None:
        sys.stderr.write(f"unknown mode {job.get('mode')!r}; expected synth|voices|warm\n")
        return 1
    try:
        fn(Models(), job)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
