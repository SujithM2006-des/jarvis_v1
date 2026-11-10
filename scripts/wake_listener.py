"""JARVIS wake listener.

A small, always-on, offline listener for "Hey Jarvis" that runs even while
JARVIS is off. When it hears the phrase it starts JARVIS (or just reopens his
window if the brain is already running), and JARVIS greets you and listens.

Detection is openWakeWord's pre-trained "hey jarvis" model: offline, free, a
few percent of one CPU core, and fast — it spots the phrase within a fraction
of a second, where the page's own recogniser has to transcribe it first. So it
stays on while JARVIS runs too: with a window open it signals it through the
bridge (POST /wake) and he chimes and listens at once, like "Hey Google".

Started and stopped by the "JARVIS - ON / OFF" switch on the desktop
(scripts/jarvis-switch.ps1) — nothing starts it with Windows — using the
isolated Python environment in %USERPROFILE%\\.jarvis\\wake-venv.
Log: %USERPROFILE%\\.jarvis\\wake-listener.log

    --threshold 0.15  how sure the model must be (0..1): raise it if JARVIS
                      starts by mistake, lower it if it misses you. Measured
                      on this PC: "Hey Jarvis" scored about 0.19-0.20, other
                      speech and silence 0.000-0.001.
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import sounddevice as sd
from openwakeword.model import Model
from openwakeword.utils import download_models

ROOT = Path(__file__).resolve().parent.parent
BAT = ROOT / "start-jarvis.bat"
HOME = Path(os.environ["USERPROFILE"]) / ".jarvis"
HOME.mkdir(parents=True, exist_ok=True)
# Present while the desktop kill switch is OFF.
KILL_SWITCH = HOME / "disabled"

logging.basicConfig(
    filename=HOME / "wake-listener.log",
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.info

RATE = 16_000
CHUNK = 1280  # 80 ms, the frame size openWakeWord expects
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def single_instance():
    """Exit quietly if another listener already holds the lock."""
    import ctypes

    ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\JarvisWakeListener")
    if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        sys.exit(0)


def bridge():
    """(bridge up, JARVIS windows connected)."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=1) as r:
            return True, int(json.load(r).get("clients", 0))
    except Exception:
        return False, 0




def wake_window():
    """Tell the open JARVIS window to listen now. True if one was there."""
    try:
        req = urllib.request.Request("http://127.0.0.1:8787/wake", data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=1) as r:
            return int(json.load(r).get("clients", 0)) > 0
    except Exception:
        return False


def start_jarvis():
    # Always through the launcher: it starts the brain only if it is not
    # already up, and opens the window on the loading screen straight away.
    log("starting JARVIS" if not bridge()[0] else "brain is running - opening the JARVIS window")
    subprocess.Popen(
        ["cmd", "/c", str(BAT), "wake"],
        cwd=ROOT,
        creationflags=NO_WINDOW,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.15)
    args = ap.parse_args()

    single_instance()
    download_models(["hey_jarvis"])  # no-op once cached
    # The voice-activity filter zeroes the score unless there is human speech,
    # which is what keeps a low threshold from firing on taps, music or fans.
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx", vad_threshold=0.5)
    log(f"ready (threshold {args.threshold})")

    stream = None
    last_fire = 0.0  # last time the phrase was acted on at all
    last_start = -1e9  # last cold start of JARVIS
    last_check = 0.0
    jarvis_on = False

    paused = False
    while True:
        try:
            # The kill switch (desktop shortcut, scripts/jarvis-switch.ps1).
            # While it is off: microphone closed, phrase ignored, nothing
            # started — including at login, since this runs from Startup.
            if KILL_SWITCH.exists():
                if not paused:
                    paused = True
                    log("switched OFF - not listening")
                if stream is not None:
                    stream.stop()
                    stream.close()
                    stream = None
                time.sleep(2)
                continue
            if paused:
                paused = False
                log("switched ON - listening again")
                last_check = 0.0

            now = time.monotonic()
            if now - last_check > 3:
                last_check = now
                up, clients = bridge()
                running = up and clients > 0
                if running != jarvis_on:
                    jarvis_on = running
                    log(
                        "JARVIS is running - waking his window on the phrase"
                        if running
                        else 'JARVIS is off - will start him on the phrase'
                    )

            if stream is None:
                stream = sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK)
                stream.start()
                model.reset()

            audio, _ = stream.read(CHUNK)
            score = float(model.predict(audio[:, 0])["hey_jarvis"])
            if score < args.threshold:
                continue

            # One utterance spans several 80 ms frames: count it once.
            if time.monotonic() - last_fire < 2:
                continue
            last_fire = time.monotonic()
            model.reset()

            # Running: wake the window on the spot, like "Hey Google". Tried
            # whenever the bridge might be up, not only when the last check
            # said so — that check is up to three seconds old.
            if jarvis_on or bridge()[0]:
                if wake_window():
                    log(f'heard "Hey Jarvis" ({score:.2f}) - woke the window')
                    continue
                jarvis_on = False  # closed since the last check: start him instead

            # Off: start him. Its own, longer cooldown, so a start in progress
            # is not started again — but a failed wake above never delays it.
            if time.monotonic() - last_start > 45:
                last_start = time.monotonic()
                log(f'heard "Hey Jarvis" ({score:.2f}) - JARVIS is off')
                start_jarvis()
                stream.stop()
                stream.close()
                stream = None
                time.sleep(20)  # let him come up before listening again
                last_check = 0.0
        except Exception as err:  # keep running whatever happens
            log(f"error: {err}")
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass
                stream = None
            time.sleep(5)


if __name__ == "__main__":
    main()
