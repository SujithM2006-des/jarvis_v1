# J.A.R.V.I.S. — a personal desktop assistant for Windows

A voice assistant with an Iron Man–style interface that actually runs your PC.
Say **"Hey Jarvis"** — even when he's switched off — and he opens, listens, and
gets on with it: opening apps and folders, finding and moving files, sending
WhatsApp messages and files, setting reminders, reading your screen, checking
your mail and calendar, and answering like the JARVIS from the films.

The face is a web page (React + Vite + Three.js) in its own Chrome window. The
brain is **Claude Code, run headless** through the Claude Agent SDK — so it uses
your existing Claude Code login. No API key is required.

---

## What he can do

**Your PC**
- Open any installed app ("open Spotify", "open VS Code", "open settings")
- Open folders in Explorer ("open downloads", "open this PC")
- Find, list, copy, move, rename and recycle files
- Copy a file's name, path or the file itself to the clipboard
- Act on whatever is **selected in File Explorer** ("copy this file's name")
- **See your screen** — "what's on my screen?", "explain this error"
- Type text into the window you're using
- Battery, Wi-Fi, disk and memory status; brightness; volume and media keys
- Play music on YouTube or Spotify
- Lock, sleep, shut down or restart (he asks before shutting down)
- Anything else through PowerShell

**WhatsApp** (WhatsApp Web, in its own logged-in Chrome window)
- "Message Mum saying I'll be late" · "send the report in downloads to Sarah"
- Read unread messages, read or summarise a chat or group
- Contacts with emoji in their names work; ambiguous names are never guessed

**A personal assistant**
- **Memory** — "remember that my exam is on the 20th"; he remembers across restarts
- **Reminders and timers** — spoken aloud with a Windows notification
- **Scheduled WhatsApp messages** — "wish Sarah happy birthday at 12 am"
- **Weather**, and a **morning briefing** ("good morning, Jarvis")
- **Gmail and Google Calendar** through your Claude account's connectors

**The experience**
- **"Hey Jarvis" works like "Hey Google"** — an offline wake-word detector
  answers in a fraction of a second, chimes, and listens. It cuts through him
  mid-sentence, and it **starts him when he's off**.
- A **desktop ON/OFF switch** — nothing starts with Windows; the switch arms him
- An instant **loading screen**, then a live **telemetry HUD**: clock, CPU and
  RAM gauges, weather, battery and Wi-Fi, schedule, activity log, and an app dock
- A **British voice** and a natural, film-style personality — calm, polished,
  dry wit, "sir" in the right places

---

## Requirements

- **Windows 10 or 11**
- **Claude Code, installed and logged in** — `npm install -g @anthropic-ai/claude-code`,
  then run `claude` once and log in. Usage is billed to your Claude account.
- **Node.js 20+** — <https://nodejs.org>
- **Google Chrome**
- **Python 3.10+** — only for the offline "Hey Jarvis" wake word and the
  ON/OFF switch. Everything else works without it.
- *Optional:* an **NVIDIA GPU** for the neural Kokoro voice, and an
  **ElevenLabs API key** for a premium voice and transcription.

---

## Setup

```bat
git clone https://github.com/SujithM2006-des/jarvis_v1.git
cd jarvis_v1
npm install
```

Optional settings go in `.env.local` (copy `.env.example`). A good start:

```ini
VITE_TTS_ENGINE=system
VITE_SYSTEM_VOICE=Google UK English Male
VITE_VOICE_RATE=1.2
VITE_SPEECH_LANG=en-IN
VITE_MUSIC_AMBIENT=off
```

### The "Hey Jarvis" wake word and the desktop switch

The wake word runs in its own small Python environment:

```bat
python -m venv "%USERPROFILE%\.jarvis\wake-venv"
"%USERPROFILE%\.jarvis\wake-venv\Scripts\python.exe" -m pip install openwakeword sounddevice numpy
```

Then put the switch on your desktop:

```bat
powershell -ExecutionPolicy Bypass -File scripts\jarvis-switch.ps1 -Install
```

Double-click **"JARVIS - ON / OFF"** on the desktop to arm or disarm him.

---

## Running it

- **Double-click `start-jarvis.bat`** — the loading screen opens instantly and
  hands over to JARVIS once he's ready, or
- **switch him ON** with the desktop switch and just say **"Hey Jarvis"**.

The first time, Chrome asks for the microphone — allow it. WhatsApp shows a QR
code the first time you use it — scan it with your phone (WhatsApp → Settings →
Linked devices).

> `start-jarvis.bat` runs the bridge with **actions enabled** (`--writes`), so he
> can open apps, change files and send messages. Use `npm start` instead for a
> read-only JARVIS.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him — chime, then speak your request |
| Say "Hey Jarvis" while he talks | Stop him and listen |
| **Space** | Talk without the wake word |
| **V** | Cycle the voice |
| **D** | Diagnostics — what he heard and why |
| **T** | Audio self-test |
| **Escape** | Stand down |
| Desktop **JARVIS - ON / OFF** | Arm / disarm "Hey Jarvis"; OFF also closes him |

---

## How it works

```
 ┌ wake listener (Python) ┐   POST /wake      ┌─ bridge (Node, :8787) ───────────────┐
 │ openWakeWord, offline  │ ────────────────► │ Claude Agent SDK = Claude Code       │
 │ starts JARVIS if off   │                   │ tools: PC, WhatsApp, memory,         │
 └────────────────────────┘                   │ reminders, weather, HUD, browser     │
                                              │ scheduler · /status · tool policy    │
 ┌─ JARVIS window (Chrome, :5188) ─────┐  ws  │                                      │
 │ loading screen → HUD + reactor      │◄───► │                                      │
 │ speech recognition + voice          │      └──────────────────────────────────────┘
 └─────────────────────────────────────┘
```

- `start-jarvis.bat` opens `scripts/splash.html` (the loading screen) straight
  from disk, starts the bridge and the interface, and the loading screen switches
  to the interface (`http://localhost:5188`) the moment both answer.
- The **bridge** (`bridge/server.mjs`) runs Claude Code headless and gives it
  JARVIS's tools: `bridge/pc.mjs` and `bridge/desktop.mjs` (the PC),
  `bridge/whatsapp.mjs` (WhatsApp Web via Playwright), `bridge/assistant.mjs`
  (memory, reminders, weather) and `bridge/telemetry.mjs` (HUD readings).
- The **wake listener** (`scripts/wake_listener.py`) hears "Hey Jarvis" offline.
  With JARVIS open it signals the window through the bridge; with JARVIS off it
  runs `start-jarvis.bat wake`.
- **Your data stays on your PC**, in `%USERPROFILE%\.jarvis`: `memory.md`,
  `reminders.json`, the WhatsApp login, and logs (`jarvis.log`,
  `wake-listener.log`).

---

## Configuration

Frontend settings go in `.env.local`; bridge settings are environment variables.
`.env.example` documents every one. The most useful:

| Setting | Effect |
|---|---|
| `VITE_SYSTEM_VOICE` | Voice by name, e.g. `Google UK English Male`, `David` |
| `VITE_VOICE_RATE` | Speaking pace (1.0 natural, 1.2 brisk) |
| `VITE_TTS_ENGINE` | `system` (instant) or `kokoro` (neural, British, GPU) |
| `VITE_SPEECH_LANG` | Recognition accent: `en-IN`, `en-GB`, `en-US` … |
| `VITE_END_PAUSE_MS` | Quiet that ends a command — raise it if you get cut off |
| `VITE_MUSIC_AMBIENT` / `VITE_MUSIC` | `off` to drop the background music / all music |
| `VITE_AUTOSTART` | `off` brings back the INITIALISE button |
| `JARVIS_PERSONA` | `formal` for the original terse film-butler persona |
| `JARVIS_MODEL` / `JARVIS_EFFORT` | Model and reasoning effort |
| `JARVIS_DISABLE` | Leave out `pc`, `whatsapp`, `browser`, `camera`, `interface` |
| `JARVIS_ALLOW_WRITES` | `1` enables actions (the `.bat` passes `--writes`) |

The wake word's sensitivity is `--threshold` in `scripts/wake_listener.py`
(default 0.15): raise it if JARVIS starts by mistake, lower it if he misses you.

---

## Safety

JARVIS can act on your PC, so the bridge keeps a tool gate (`bridge/policy.mjs`):

- **Read-only unless writes are on.** Without `--writes`, nothing that changes
  files, runs commands or sends messages is even offered to the model.
- **System folders and credentials are refused** by the file tools (Windows,
  Program Files, AppData, `.ssh`, `.env` files …); deletions go to the Recycle
  Bin; copies and moves never overwrite.
- **WhatsApp never guesses** — an ambiguous contact name sends nothing and asks.
- **Shut-down and restart** require a spoken yes, and wait 60 seconds.
- The bridge listens on `127.0.0.1` only, checks Origin and Host on every
  request (blocking other sites and DNS rebinding), and its media/page proxies
  refuse private network addresses.
- `run_powershell` can do anything your user account can. That is what makes
  "do anything on my PC" possible — keep it in mind, and use the switch to turn
  JARVIS off when you don't want him listening.

---

## Troubleshooting

- **Logs:** `%USERPROFILE%\.jarvis\jarvis.log` records what he heard, what he
  said, every tool result and every voice event. Press **D** for live diagnostics.
- **He cuts me off mid-sentence:** raise `VITE_END_PAUSE_MS` (e.g. 2000). Talking
  over him while he speaks confuses the browser's recogniser — say "Hey Jarvis"
  to stop him first.
- **"Hey Jarvis" does nothing:** check the switch is ON and see
  `wake-listener.log`.
- **Port 5188 in use:** JARVIS uses its own port so other Vite projects on 5173
  don't clash; free 5188 or set `PORT` (keep it within 5173–5199).
- **No sound:** press **T**. `Google UK English Male` needs internet; set
  `VITE_SYSTEM_VOICE=David` for an offline voice.

---

## Tests

`npm test` runs the bridge's tests (network binding, tool policy, MCP allowlist).

---

## Credits & licence

MIT. Built on an open-source JARVIS voice-assistant project (bridge, reactor
interface and voice pipeline), extended into a Windows personal assistant.
Music by Kevin MacLeod (incompetech.com), CC BY 4.0 — see
`public/audio/CREDITS.md`. Wake word by [openWakeWord](https://github.com/dscripka/openWakeWord).
