"""Transcribe a 16 kHz mono 16-bit WAV file offline with Vosk.

Used by the bridge's transcribe_audio tool (bridge/customize.mjs): the browser
decodes whatever the user attached (mp3, m4a, ogg …) to plain 16 kHz samples,
the bridge writes them as a WAV, and this prints the words. Runs in the wake
listener's environment (%USERPROFILE%\\.jarvis\\wake-venv), which has Vosk and
the small Indian English model already — nothing leaves the machine.

    python transcribe.py file.wav    -> the transcript on stdout
"""

import json
import os
import sys
import wave
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel

_VOSK = Path(os.environ["USERPROFILE"]) / ".jarvis" / "vosk"
# The big Indian English model when installed (far more accurate), else the small one.
MODEL = next(
    (p for p in (_VOSK / "vosk-model-en-in-0.5", _VOSK / "vosk-model-small-en-in-0.4") if p.exists()),
    _VOSK / "vosk-model-small-en-in-0.4",
)


def main(path):
    SetLogLevel(-1)
    if not MODEL.exists():
        sys.exit("The offline speech model is not installed (~/.jarvis/vosk).")
    with wave.open(path, "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            sys.exit("Expected 16-bit mono audio.")
        rec = KaldiRecognizer(Model(str(MODEL)), wav.getframerate())
        parts = []
        while True:
            data = wav.readframes(8000)
            if not data:
                break
            if rec.AcceptWaveform(data):
                parts.append(json.loads(rec.Result()).get("text", ""))
        parts.append(json.loads(rec.FinalResult()).get("text", ""))
    sys.stdout.reconfigure(encoding="utf-8")
    print(" ".join(p for p in parts if p).strip())


if __name__ == "__main__":
    main(sys.argv[1])
