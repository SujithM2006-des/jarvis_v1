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
# Present while the microphone is muted from the onscreen popup: same effect
# as the kill switch for listening, but JARVIS himself stays running.
MUTED = HOME / "muted"

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


REMINDERS = HOME / "reminders.json"

# A Windows notification that stays until dismissed (as bridge/assistant.mjs).
TOAST_PS = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
function X($s) { [Security.SecurityElement]::Escape($s) }
$doc = "<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$(X $env:JARVIS_T)</text><text>$(X $env:JARVIS_B)</text></binding></visual><actions><action content='Dismiss' arguments='dismiss' activationType='system'/></actions><audio src='ms-winsoundevent:Notification.Reminder'/></toast>"
$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($doc)
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))
"""


def toast(title, body):
    env = dict(os.environ, JARVIS_T=title, JARVIS_B=body)
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", TOAST_PS],
        env=env, creationflags=NO_WINDOW, timeout=20, check=False,
    )


def fire_due_reminders():
    """While JARVIS is off: show due reminders and timers, and move repeating
    ones to their next time — the same bookkeeping the bridge does. Scheduled
    WhatsApp messages are left for the bridge, which sends them when it starts
    (if they are not hours late)."""
    from datetime import datetime, timedelta, timezone

    try:
        items = json.loads(REMINDERS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(items, list):
        return
    now = datetime.now(timezone.utc)
    keep, fired = [], 0
    for r in items:
        try:
            at = datetime.fromisoformat(str(r.get("at", "")).replace("Z", "+00:00"))
            if at.tzinfo is None:
                at = at.astimezone()
        except ValueError:
            keep.append(r)
            continue
        if at > now or r.get("kind") == "whatsapp":
            keep.append(r)
            continue
        late = now - at
        note = f" (due {at.astimezone():%I:%M %p})" if late > timedelta(minutes=5) else ""
        title = "Jarvis timer" if r.get("kind") == "timer" else "Jarvis reminder"
        toast(title, f"{r.get('text', '')}{note}")
        fired += 1
        step = {"daily": 1, "weekly": 7}.get(r.get("repeat") or "", 0)
        if step:
            while at <= now:
                at += timedelta(days=step)
            keep.append({**r, "at": at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")})
    if fired:
        tmp = REMINDERS.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(keep, indent=2), encoding="utf-8")
        os.replace(tmp, REMINDERS)
        log(f"showed {fired} reminder(s) while JARVIS was off")


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
        # The bridge's local key, made fresh at each start (bridge/server.mjs).
        try:
            token = (HOME / "bridge-token").read_text().strip()
        except OSError:
            token = ""
        req = urllib.request.Request(
            "http://127.0.0.1:8787/wake", data=b"", method="POST",
            headers={"x-jarvis-token": token},
        )
        with urllib.request.urlopen(req, timeout=1) as r:
            return int(json.load(r).get("clients", 0)) > 0
    except Exception:
        return False


PENDING = HOME / "pending-command.json"


def capture_command(stream, vosk_model, limit=8.0, quiet=1.3):
    """Right after "Hey Jarvis" with JARVIS off: transcribe what follows (up to
    `limit` seconds, ending at `quiet` seconds of silence after speech) with
    Vosk, free-form, and leave it for his window (GET /pending-command)."""
    from vosk import KaldiRecognizer

    rec = KaldiRecognizer(vosk_model, RATE)
    start = time.monotonic()
    heard_at = None
    parts = []
    while time.monotonic() - start < limit:
        if stream.read_available < CHUNK:
            time.sleep(0.02)
            continue
        audio, _ = stream.read(CHUNK)
        if int(np.abs(audio).max()) > 1500:
            heard_at = time.monotonic()
        if rec.AcceptWaveform(audio.tobytes()):
            parts.append(json.loads(rec.Result()).get("text", ""))
        if heard_at and time.monotonic() - heard_at > quiet:
            break
        if not heard_at and time.monotonic() - start > 3.5:
            break  # nothing said after his name: he will just listen
    parts.append(json.loads(rec.FinalResult()).get("text", ""))
    text = " ".join(p for p in parts if p).strip()
    # Strip a repeated wake phrase the recogniser may have caught again.
    for lead in ("hey jarvis", "jarvis"):
        if text.startswith(lead):
            text = text[len(lead):].strip()
    if len(text.split()) >= 2:
        PENDING.write_text(json.dumps({"text": text, "at": int(time.time() * 1000)}), encoding="utf-8")
        log(f'caught the command while starting: "{text}"')


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

    # A second detector: Vosk's small Indian English model, listening only for
    # the phrase. openWakeWord was trained mostly on synthetic American voices
    # and scores some accents near zero; either detector hearing it is enough.
    # Optional — without the model folder the listener runs on openWakeWord.
    vosk_rec = None
    vosk_model = None
    vosk_dir = HOME / "vosk" / "vosk-model-small-en-in-0.4"
    if vosk_dir.exists():
        try:
            from vosk import KaldiRecognizer, Model as VoskModel, SetLogLevel

            SetLogLevel(-1)
            vosk_model = VoskModel(str(vosk_dir))
            vosk_rec = KaldiRecognizer(
                vosk_model, RATE, json.dumps(["hey jarvis", "jarvis", "[unk]"])
            )
        except Exception as err:
            log(f"Vosk unavailable, using openWakeWord alone: {err}")
    log(f"ready (threshold {args.threshold}, Vosk {'on' if vosk_rec else 'off'})")

    stream = None
    last_fire = 0.0  # last time the phrase was acted on at all
    last_start = -1e9  # last cold start of JARVIS
    last_check = 0.0
    last_reminders = 0.0
    jarvis_on = False
    last_data = last_sound = time.monotonic()
    stat_at, stat_peak, stat_score = time.monotonic(), 0, 0.0

    paused = False
    while True:
        try:
            # The kill switch (desktop shortcut, scripts/jarvis-switch.ps1).
            # While it is off: microphone closed, phrase ignored, nothing
            # started — including at login, since this runs from Startup.
            off = KILL_SWITCH.exists()
            if off or MUTED.exists():
                if not paused:
                    paused = True
                    log("switched OFF - not listening" if off else "microphone MUTED - not listening")
                if stream is not None:
                    stream.stop()
                    stream.close()
                    stream = None
                # Short while muted, so unmuting takes effect almost at once.
                time.sleep(2 if off else 0.5)
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
                # With the brain down nobody else is watching the clock:
                # reminders and timers still pop up as notifications.
                if not up and now - last_reminders > 30:
                    last_reminders = now
                    fire_due_reminders()

            if stream is None:
                stream = sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK)
                stream.start()
                model.reset()
                last_data = last_sound = time.monotonic()

            # Never block on the microphone: a device that stops delivering
            # audio (Chrome letting go of it, a driver hiccup) would otherwise
            # freeze this loop silently — alive, logging nothing, hearing
            # nothing. No audio for 3 s, or pure digital silence for 30 s,
            # and the stream is reopened.
            now = time.monotonic()
            if stream.read_available < CHUNK:
                if now - last_data > 3:
                    log("microphone stalled - reopening it")
                    stream.close()
                    stream = None
                else:
                    time.sleep(0.02)
                continue
            audio, _ = stream.read(CHUNK)
            last_data = now
            peak = int(np.abs(audio).max())
            if peak > 0:
                last_sound = now
            elif now - last_sound > 30:
                log("microphone gave pure silence for 30 s - reopening it")
                stream.close()
                stream = None
                continue

            score = float(model.predict(audio[:, 0])["hey_jarvis"])

            # Once a minute: proof of life, and what it is actually hearing.
            stat_peak = max(stat_peak, peak)
            stat_score = max(stat_score, score)
            if now - stat_at > 60:
                log(f"listening - loudest {stat_peak}, best score {stat_score:.2f}")
                stat_at, stat_peak, stat_score = now, 0, 0.0

            # Vosk: only the whole phrase "hey jarvis", and only on a finished
            # result. Restricted to a tiny grammar it forces near-misses onto
            # the nearest phrase — accepting "jarvis" alone or partial results,
            # "go to stand by" woke him six times in a minute. Runs whether he
            # is open or not: it is the detector that copes with an Indian
            # accent, and the page ignores a wake while it is already listening,
            # so a stray one cannot chop a sentence.
            vosk_heard = False
            if vosk_rec is not None:
                if vosk_rec.AcceptWaveform(audio.tobytes()):
                    vosk_heard = "hey jarvis" in json.loads(vosk_rec.Result()).get("text", "")
            if score < args.threshold and not vosk_heard:
                continue
            if vosk_heard and score < args.threshold:
                score = 1.0  # for the log: it was Vosk that caught it
                log('Vosk caught "Hey Jarvis"')

            # One utterance spans several 80 ms frames: count it once.
            if time.monotonic() - last_fire < 2:
                continue
            last_fire = time.monotonic()
            model.reset()
            if vosk_rec is not None:
                vosk_rec.Reset()

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
                # He takes a while to come up; whatever is said in the
                # meantime ("Hey Jarvis, what's the weather") is caught here,
                # offline, and answered the moment he is ready.
                if vosk_model is not None:
                    capture_command(stream, vosk_model)
                stream.stop()
                stream.close()
                stream = None
                time.sleep(12)  # let him come up before listening again
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
