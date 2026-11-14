import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Setup } from './ui/Setup'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, listVoices, setVoiceProfile } from './lib/tts'
import { analyseVoice } from './lib/voiceprint'
import CustomLayout from './custom/CustomLayout'
import { LayoutBoundary } from './custom/LayoutBoundary'
import { lastLayoutError, retryLayout, useHidden } from './custom/kit'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  endSession,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchAnnounce,
  watchRemoteWake,
  watchPopupAsk,
  watchMic,
  watchMute,
  watchCircle,
  reportPhase,
  reportPartial,
  handleRequest,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env, BRIDGE_HTTP_URL } from './config'

// Hot updates are unsafe here: the voice loop, the recogniser and the bridge
// socket are started once per page, and a hot-swapped component starts a second
// set beside the first — JARVIS then deafens itself fighting over the
// microphone. Any code change reloads the whole page instead.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => window.location.reload())
}

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/**
 * Phrases that put him on standby. Matched only against a short utterance, so
 * "remind me to go to sleep at eleven" is still a request, not a command.
 */
const STANDBY =
  /\b(go(ing)?\s+(in)?to\s+(stand\s*-?\s*by|standby|sleep)|stand\s*-?\s*by(\s+mode)?|standby(\s+mode)?|stand\s+down|stop\s+listening|go\s+to\s+sleep|sleep\s+mode|that'?s\s+all|good\s*bye|bye\s+bye|dismissed)\b/i
const STANDBY_MAX_WORDS = 7

/** "Turn on / off onscreen jarvis" — the Copilot-style popup (scripts/popup.ps1). */
const POPUP_ON =
  /\b(turn\s+on|switch\s+on|open|show|start|enable|launch)\s+(the\s+)?(on\s*-?\s*screen|onscreen|pop\s*-?\s*up|popup|mini)(\s+mode)?(\s+jarvis)?\b/i
const POPUP_OFF =
  /\b(turn\s+off|switch\s+off|close|hide|stop|disable)\s+(the\s+)?(on\s*-?\s*screen|onscreen|pop\s*-?\s*up|popup|mini)(\s+mode)?(\s+jarvis)?\b/i
/** "Mute the microphone" — the popup's mute, by voice. Unmuting is the button
 *  (or the mic button): once muted, nothing spoken is heard. */
const MUTE_MIC = /\b(mute|turn\s+off|switch\s+off|disable)\s+(the\s+|my\s+|your\s+)?(mic|microphone)\b/i
/** "Circle to search" — the screen overlay (scripts/circle.ps1). */
const CIRCLE = /\bcircle\s+(to|and|n)?\s*search\b|\bcircle\s+something\b/i

/** Ask the bridge to do something on the desktop (popup, circle overlay). */
const desktop = (path: string) =>
  fetch(`${BRIDGE_HTTP_URL}${path}`, { method: 'POST' }).catch(() => undefined)
const STANDBY_LINES = [
  'Standing by, sir.',
  "Very good, sir. I'll be here.",
  "Of course. Just say the word when you need me.",
  'Going quiet, sir.',
]

/** Answer the wake word with a spoken line as well as the chime. Off by default. */
const WAKE_GREETING_SPOKEN =
  String(import.meta.env.VITE_WAKE_GREETING ?? '').trim().toLowerCase() === 'spoken'

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /**
   * "Go to standby", said out loud. Handled here rather than sent to the
   * model: the model would say "Standing by" while the follow-up window kept
   * the microphone open, so he went on answering everything said in the room.
   * This acknowledges briefly and closes the mic until the next "Hey Jarvis".
   */
  const standBy = () => {
    const phase = store.getState().phase
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') interrupt()
    goDormant()
    const s = createSpeaker()
    speaker.current = s
    s.say(STANDBY_LINES[Math.floor(Math.random() * STANDBY_LINES.length)])
    void s.end()
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  /**
   * The request most recently sent, and whether he has started answering it.
   * If the user carries on talking before he does, that was a pause, not the
   * end: the fragment is abandoned and re-sent joined to what came next.
   */
  const lastAsk = useRef({ text: '', at: 0, answered: true })
  const carryOver = useRef('')
  const CONTINUATION_MS = 8000

  /**
   * Sessions. Each request belongs to the session on screen when it was made,
   * and keeps writing its answer there even if another session is opened
   * meanwhile — it runs on in the background. Only the turn that still holds
   * the voice (`turn`, bumped by any new request or by switching sessions)
   * speaks and drives the phase. A new request in the SAME session supersedes
   * the one there (`sessionTurn`).
   */
  const sessionTurn = useRef(new Map<string, number>())

  const respond = async (raw: string): Promise<void> => {
    // "Retry" in the chat view: shown as the original request, asked for anew.
    const retry = /^\[Retry\]\s*/.test(raw)
    const said = raw.replace(/^\[Retry\]\s*/, '')
    const mine = ++turn.current
    const sid = store.getState().activeSession
    const mineHere = (sessionTurn.current.get(sid) ?? 0) + 1
    sessionTurn.current.set(sid, mineHere)
    lastAsk.current = { text: said, at: Date.now(), answered: false }
    /** Superseded in its own session: stop everything. */
    const gone = () => sessionTurn.current.get(sid) !== mineHere
    /** No longer the voiced turn (or superseded): stay quiet, keep writing. */
    const stale = () => gone() || mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said }, sid)
    /**
     * The chat view: the answer is read on screen, so the model is told to
     * write it out in full (formatted), and only its opening line is spoken.
     * Checked as the answer streams too — a long answer can switch the view
     * on part way through.
     */
    const inChat = () => Boolean(store.getState().sessions.find((x) => x.id === sid)?.chat)
    const asked = retry ? `Answer this again, differently and better than your last answer to it: ${said}` : said
    const request = inChat() ? `[Chat] ${asked}` : asked
    let heard = ''
    let speaking = true
    s.setSessionBusy(sid, true)
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text } = await ask(request, history.current, {
        onText: (delta) => {
          if (gone()) return
          // The answer is written into its session either way; only the
          // voiced turn speaks it and moves the orb.
          if (!started) {
            started = true
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' }, sid)
            if (!stale()) {
              lastAsk.current.answered = true
              store.getState().setPhase('speaking')
              // The answer arriving is what ends the tool phase — a timer would
              // clear the readout while a slow tool was still running.
              store.getState().setActiveTool(null)
              music.working(false)
            }
          }
          store.getState().appendToLastTurn(delta, sid)
          if (stale() || !speaking) return
          // In the chat view only the opening line is spoken: up to the
          // first line break (or ~300 characters); the rest is for reading.
          if (inChat()) {
            const cut = delta.indexOf('\n')
            if (cut >= 0 && (heard + delta.slice(0, cut)).trim()) {
              spk.push(delta.slice(0, cut))
              speaking = false
              return
            }
            if (heard.length > 300) {
              speaking = false
              return
            }
          }
          heard += delta
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, sid)

      // A background session's answer may have arrived only as the final
      // text (no stream): file it there.
      if (!gone() && !started && text) {
        store.getState().pushTurn({ id: turnId, role: 'jarvis', text }, sid)
        started = true
      }

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (gone()) return
      console.error(err)
      const why = err instanceof Error ? err.message : 'Something went wrong.'
      // A background session's failure is noted in that session instead.
      if (stale()) {
        store.getState().pushTurn({ id: newId(), role: 'jarvis', text: `⚠ ${why}` }, sid)
        return
      }
      sfx.play('error')
      store.getState().setError(why)
    } finally {
      if (!gone()) store.getState().setSessionBusy(sid, false)
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    if (muted.current) return 'deaf'
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  /**
   * When the last wake landed. Two detectors hear the same "Hey Jarvis" — the
   * offline one in the background listener and the recogniser in this page —
   * and a second wake inside this window would restart the listen and chime
   * twice, so only the first counts.
   */
  const lastWakeAt = useRef(0)
  const WAKE_DEDUP_MS = 2500
  const greetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Microphone muted from the popup: deaf, recogniser stopped. */
  const muted = useRef(false)
  const GREETING_DELAY_MS = 1500

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    const recent = Date.now() - lastWakeAt.current < WAKE_DEDUP_MS
    // Already woken a moment ago by the other detector: a bare repeat is the
    // same call, and a repeat with words after it is the command itself.
    if (recent && (phase === 'waking' || phase === 'listening')) {
      if (trailing) void respond(trailing)
      return
    }
    lastWakeAt.current = Date.now()

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Like "Hey Google": a chime and an open microphone, nothing spoken. A
    // greeting costs a second or more before the user can talk, every time.
    // VITE_WAKE_GREETING=spoken brings the spoken "Yes, sir?" back.
    listen(AWAIT_SPEECH_MS)

    // The spoken "Yes, sir?" waits for a pause: only if the user hasn't begun
    // talking within GREETING_DELAY_MS. Said straight away it landed on top of
    // "Hey Jarvis, open…" and cut the request off. onSpeechStart cancels it.
    if (WAKE_GREETING_SPOKEN) {
      if (greetTimer.current) clearTimeout(greetTimer.current)
      greetTimer.current = setTimeout(() => {
        greetTimer.current = null
        if (store.getState().phase !== 'listening') return
        const greeting = createSpeaker()
        speaker.current = greeting
        greeting.say(attention())
        void greeting.end()
      }, GREETING_DELAY_MS)
    }
  }

  /**
   * "Hey Jarvis" heard by the background listener (scripts/wake_listener.py),
   * which detects it on the device in a fraction of a second. Like the
   * assistant on a phone, it cuts through whatever he is doing — talking or
   * still working on the last request — and listens.
   */
  const onRemoteWake = () => {
    const phase = store.getState().phase
    // Logged (it reaches ~/.jarvis/jarvis.log) so a wake that "did nothing"
    // shows what state he was in when it arrived.
    console.warn(`[voice] background wake received (phase ${phase})`)
    if (phase === 'offline' || phase === 'boot') return
    // Already listening: nothing to wake. Acting on it restarted the listen,
    // which chopped whatever the user was in the middle of saying.
    if (phase === 'waking' || phase === 'listening') return
    if (Date.now() - lastWakeAt.current < WAKE_DEDUP_MS) return
    if (phase === 'speaking' || phase === 'thinking' || phase === 'tooling') {
      silence()
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      music.duck(false)
    }
    onWake('')
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    // They've started talking: the pending "Yes, sir?" is no longer wanted.
    if (greetTimer.current) {
      clearTimeout(greetTimer.current)
      greetTimer.current = null
    }
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    // Still talking, and he has not begun to answer the last thing sent: that
    // was a pause mid-request. Keep it, to join to whatever comes next.
    const last = lastAsk.current
    if (wasBusy && !last.answered && Date.now() - last.at < CONTINUATION_MS) {
      carryOver.current = last.text
    }

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    let said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    // The first half of this request was sent too early (see onSpeechStart):
    // send the whole thing together instead of answering half a sentence.
    if (carryOver.current) {
      const carry = carryOver.current
      const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
      // The recogniser often re-delivers the first half along with the rest;
      // joining then would send the request twice over.
      const k = key(said)
      const kc = key(carry)
      if (!k.startsWith(kc.slice(0, 40)) && !kc.includes(k)) said = `${carry} ${said}`
      else if (kc.includes(k)) said = carry
      carryOver.current = ''
      console.warn(`[voice] joined a cut-off request: "${said.slice(0, 80)}"`)
    }

    // "Go to standby" — handled here, never sent to the model.
    if (STANDBY.test(said) && said.split(/\s+/).length <= STANDBY_MAX_WORDS) {
      console.warn(`[voice] standby on "${said}"`)
      standBy()
      return
    }

    // "Mute the microphone": confirmed, then deaf until unmuted from the popup.
    if (MUTE_MIC.test(said) && said.split(/\s+/).length <= 8) {
      console.warn(`[voice] mute on "${said}"`)
      const s = createSpeaker()
      speaker.current = s
      s.say("Microphone muted, sir. Unmute me from the panel when you need me.")
      void s.end()
      void fetch(`${BRIDGE_HTTP_URL}/popup/mute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: true }),
      }).catch(() => undefined)
      goDormant()
      return
    }

    // Desktop commands, also handled here so they work instantly and reliably.
    const short = said.split(/\s+/).length <= 8
    if (short && (POPUP_ON.test(said) || POPUP_OFF.test(said) || CIRCLE.test(said))) {
      const on = POPUP_ON.test(said)
      const circle = CIRCLE.test(said)
      console.warn(`[voice] desktop command: "${said}"`)
      void desktop(circle ? '/circle' : on ? '/popup/show' : '/popup/hide')
      const s = createSpeaker()
      speaker.current = s
      s.say(
        circle
          ? 'Circle whatever you like, sir.'
          : on
            ? "Onscreen mode, sir. I'll be in the corner."
            : 'Closing the onscreen panel, sir.',
      )
      void s.end()
      listen(FOLLOW_UP_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
    // Mirror the words onto the onscreen popup as they are spoken.
    const t = text.trim()
    if (t && t !== '…' && store.getState().phase === 'listening') reportPartial(t)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    // music.playBoot()  // boot intro disabled
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // Customising his voice, on request (bridge/customize.mjs): measure a
    // recording the user gave, and apply the voice he chose to match it.
    handleRequest('voice-analyze', async (msg) => {
      const { features, suggestion } = await analyseVoice(String(msg.data ?? ''))
      return { features, suggestion, voices: listVoices() }
    })
    handleRequest('voice-set', async (msg) => {
      const r = msg.reset
        ? setVoiceProfile(null)
        : setVoiceProfile({
            voice: (msg.voice as string | null) ?? null,
            rate: (msg.rate as number | null) ?? null,
            pitch: (msg.pitch as number | null) ?? null,
          })
      console.warn(`[voice] voice profile -> ${JSON.stringify(r)}`)
      return r as Record<string, unknown>
    })

    // Transcribing a recording (bridge transcribe_audio): the browser decodes
    // any format to 16 kHz mono 16-bit samples for the offline recogniser.
    handleRequest('audio-pcm', async (msg) => {
      const bytes = Uint8Array.from(atob(String(msg.data ?? '')), (c) => c.charCodeAt(0))
      const ctx = new OfflineAudioContext(1, 16000, 16000)
      const buf = await ctx.decodeAudioData(bytes.buffer)
      const n = Math.min(buf.length, 16000 * 600) // ten minutes at most
      const pcm = new Int16Array(n)
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c)
        for (let i = 0; i < n; i++) pcm[i] += Math.max(-1, Math.min(1, ch[i] / buf.numberOfChannels)) * 32767
      }
      const b = new Uint8Array(pcm.buffer)
      let bin = ''
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
      return { pcm: btoa(bin), seconds: Math.round(n / 16000), truncated: buf.length > n }
    })

    // After JARVIS applies a new layout: did it render, and does it run
    // smoothly? The bridge rolls it back if not (bridge/customize.mjs).
    handleRequest('layout-check', async () => {
      retryLayout()
      await new Promise((r) => setTimeout(r, 1500))
      // A hidden (minimised) page gets no animation frames at all, so speed
      // can only be measured while it is on screen; capped at 2 s regardless.
      const hidden = document.visibilityState === 'hidden'
      let fps: number | null = null
      if (!hidden) {
        let frames = 0
        const t0 = performance.now()
        await Promise.race([
          new Promise<void>((done) => {
            const tick = () => {
              frames++
              if (performance.now() - t0 < 1000) requestAnimationFrame(tick)
              else done()
            }
            requestAnimationFrame(tick)
          }),
          new Promise<void>((done) => setTimeout(done, 2000)),
        ])
        fps = Math.round((frames * 1000) / (performance.now() - t0))
      }
      return { error: null, layoutError: lastLayoutError(), fps, hidden }
    })

    // Reminders and timers: spoken the moment they fall due, unasked. A fresh
    // speaker held in the same slot as any other line, so saying "stop" or
    // starting to talk cuts it off like anything else he says.
    watchRemoteWake(() => onRemoteWake())

    // The onscreen popup: what was typed there is a request like any other,
    // and the window's phase is mirrored to it.
    const fromDesk = (text: string) => {
      const phase = store.getState().phase
      if (phase === 'offline' || phase === 'boot') return
      if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
        silence()
        interrupt()
      }
      void respond(text)
    }
    watchPopupAsk(fromDesk)

    // The popup's mic button: a toggle. Listening already → standby;
    // otherwise listen now, cutting through anything he is saying or doing.
    // The popup's mute: nothing is heard until unmuted. Listening stops at once
    // (quietly — no "standing by"); an answer already being spoken finishes.
    watchMute((on) => {
      if (muted.current === on) return
      muted.current = on
      console.warn(`[voice] microphone ${on ? 'muted' : 'unmuted'}`)
      store.getState().setCaption('')
      const phase = store.getState().phase
      if (on && (phase === 'listening' || phase === 'waking')) goDormant()
    })

    watchMic(() => {
      const phase = store.getState().phase
      if (phase === 'offline' || phase === 'boot') return
      console.warn(`[voice] popup mic tapped (phase ${phase})`)
      if (phase === 'listening' || phase === 'waking') {
        standBy()
        return
      }
      if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
        silence()
        interrupt()
        store.getState().setActiveTool(null)
      }
      lastWakeAt.current = 0 // a tap is deliberate: never swallowed as a duplicate wake
      onWake('')
    })

    // Circle to Search: the user circled part of the screen; the crop is a
    // PNG in the temp folder, which his file tools can read and see.
    watchCircle((path) =>
      fromDesk(
        `I've circled something on my screen. The cropped image is at ${path}. ` +
          'Look at it (read the image file), tell me what it is, and if it helps, ' +
          'search the web for it and give me the key facts — like Circle to Search. ' +
          "Don't read the file path aloud.",
      ),
    )

    reportPhase(store.getState().phase)
    useStore.subscribe((st, prev) => {
      if (st.phase !== prev.phase) reportPhase(st.phase)
    })

    watchAnnounce((text) => {
      const s = createSpeaker()
      speaker.current = s
      s.say(text)
      void s.end()
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    //
    // A blip — the bridge restarting to apply new settings, a few seconds at
    // most — reconnects quietly; only a drop that lasts is shown, and it clears
    // itself once he is back. (Recent conversation comes back from his journal,
    // so the old "was not kept" warning no longer holds.)
    let lostTimer = 0
    let shown = false
    const LOST_MSG = 'Reconnecting to the brain…'
    watchConnection((state) => {
      if (state === 'lost') {
        window.clearTimeout(lostTimer)
        lostTimer = window.setTimeout(() => {
          shown = true
          store.getState().setError(LOST_MSG)
        }, 8000)
      } else if (state === 'reconnected') {
        window.clearTimeout(lostTimer)
        if (shown && store.getState().error === LOST_MSG) store.getState().setError(null)
        shown = false
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          // The footer named the stand-in system voice until now.
          store.getState().setVoice(currentVoiceName())
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Straight to the interface. The old in-page boot animation (status bar,
    // suit figure, arc reactor) was removed on request; the loading screen
    // (scripts/splash.html) is the only start-up shown.
    await warming
    store.getState().setConnected(connectedLabels())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload. The HUD label is set only
    // after this resolves, or it always reports the browser fallback voice
    // even when ElevenLabs is the one actually about to speak.
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
      paused: () => muted.current,
    })

    store.getState().setPhase('dormant')

    // Launched by the background wake listener (scripts/wake-listener.ps1)
    // because someone said "Hey Jarvis" while he was off. Answer that call
    // as if it had been heard here, so nobody has to say his name twice.
    const url = new URL(window.location.href)
    const woken = url.searchParams.get('wake') === '1'
    // Tidy the address so a reload is an ordinary start, not another wake.
    url.searchParams.delete('wake')
    url.searchParams.delete('from')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    if (woken) {
      // What was said after "Hey Jarvis" while he was still starting — caught
      // offline by the wake listener — is answered now, instead of lost.
      let pending = ''
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/pending-command`, { cache: 'no-store' })
        if (res.ok) pending = String((await res.json()).text ?? '').trim()
      } catch {
        /* no bridge yet: just listen */
      }
      if (pending) {
        console.warn(`[voice] answering what was said while starting: "${pending}"`)
        void respond(pending)
      } else {
        onWake('')
      }
    }
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  /**
   * Power up by itself on load, skipping the INITIALISE screen.
   *
   * The button exists because browsers block audio before a click, but the
   * Jarvis window is launched with --autoplay-policy=no-user-gesture-required
   * and microphone permission is remembered per profile, so there is nothing
   * to wait for. If a boot fails, powerOn puts the button back, and this does
   * not retry — so a refusal leaves the old screen rather than a loop.
   * VITE_AUTOSTART=off brings the button back for good.
   */
  /**
   * "Read aloud" in the chat view: the whole answer, spoken (code and tables
   * are left to the screen). Pressing it again — or anything else he says or
   * hears — stops it. 'jarvis-read-done' tells the button it has finished.
   */
  useEffect(() => {
    const done = () => window.dispatchEvent(new Event('jarvis-read-done'))
    const read = (e: Event) => {
      const text = String((e as CustomEvent<string>).detail ?? '')
        .replace(/```[\s\S]*?(```|$)/g, '\n(The code is on screen.)\n')
        .replace(/^\s*\|.*\|\s*$/gm, '')
      if (!text.trim()) return
      silence()
      const s = createSpeaker()
      speaker.current = s
      s.push(text)
      void s.end().then(() => {
        if (speaker.current === s) speaker.current = null
        done()
      })
    }
    const stop = () => {
      silence()
      done()
    }
    window.addEventListener('jarvis-read', read)
    window.addEventListener('jarvis-read-stop', stop)
    return () => {
      window.removeEventListener('jarvis-read', read)
      window.removeEventListener('jarvis-read-stop', stop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Switching sessions: the voice stops (the answer it was reading belongs to
   * the other session, which carries on working and writing in the
   * background), and the orb settles. Closing one also ends its agent in the
   * bridge, and anything still on its way for it is dropped.
   */
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.activeSession !== prev.activeSession) {
          turn.current++
          silence()
          clearIdle()
          s.setCaption('')
          s.setActiveTool(null)
          s.setError(null)
          music.working(false)
          music.duck(false)
          sfx.duck(false)
          const p = s.phase
          if (p === 'thinking' || p === 'tooling' || p === 'speaking') s.setPhase('dormant')
        }
        if (s.sessions !== prev.sessions) {
          for (const old of prev.sessions) {
            if (s.sessions.some((x) => x.id === old.id)) continue
            sessionTurn.current.set(old.id, (sessionTurn.current.get(old.id) ?? 0) + 1)
            endSession(old.id)
          }
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    if (String(import.meta.env.VITE_AUTOSTART ?? '').trim().toLowerCase() === 'off') return
    const t = window.setTimeout(() => {
      if (store.getState().phase === 'offline') void powerOn()
    }, 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A custom layout, written by JARVIS on request from a picture: drawn over
  // the scene and under the HUD's live parts (panels, blades, transcript). It
  // names the stock parts it replaces (useHide), which are then not rendered.
  const hiddenNow = useHidden()

  return (
    <>
      {/* Not rendered at all when a custom layout replaces it: made invisible
          with CSS, the 3D scene kept drawing every frame on the GPU. */}
      {!hiddenNow.includes('scene') && <Scene />}
      <LayoutBoundary>
        <CustomLayout />
      </LayoutBoundary>
      <Hud />
      <Setup />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
