# Form answers

Copy-paste for the Voice Hackathon Week submission form. Fill in the bracketed
bits.

---

**What are you submitting?**
☑ A project I built
☑ API feedback (bug or suggestion)

**Team or submitter name**
Adam Ososki

**Primary contact email**
adamososki1@gmail.com

**Discord username**
`[your Discord handle]`

**Twitter / LinkedIn**
`[your LinkedIn URL]`

**Project name**
Speakdown

**One-line project tagline**
Dictate the prose, speak the formatting — markdown that transcribes while you are still talking.

---

**Project description**

Speakdown is a markdown editor you drive entirely by voice. You dictate prose
normally and speak the formatting out loud: "heading two", "bullet list", "code
block", "bold that", "scratch that". Structured markdown appears live beside a
rendered preview. No keyboard, no toolbar.

It is built around one line in the Dictation API docs: the endpoint transcribes
the audio it has while the rest is still arriving. So Speakdown opens the HTTP
request the instant its voice-activity detector hears you start, and pushes raw
PCM up as the microphone produces it. Transcription happens while you are still
talking, and when you stop, the only thing left to process is the tail. The dock
reports "wait after speech" rather than total round trip, because that is the
number a person actually feels — and a Settings toggle switches to a buffered
whole-clip upload so you can measure the difference live.

The browser cannot stream a fetch body over HTTP/1.1 (Chrome requires HTTP/2 and
fails with ERR_ALPN_NEGOTIATION_FAILED; Firefox and Safari do not support request
streaming at all), so the browser posts each ~120 ms of PCM to a local Node
proxy, which splices those frames into one long-lived upstream request. That keeps
the genuine chunked upload on the hop that matters, works in every browser, and
needs no TLS certificate.

`keyterms_prompt` carries all 29 command phrases on every request — without it
"heading two" transcribes as "heading too" and the local parser never sees a
command. `stt_prompt` describes the situation rather than instructing the model,
as the docs specify. `llm_instruction` is deliberately omitted so the default
cleanup runs; because the response returns both `text` and `llm_response`, the
editor keeps every transcript and a Cleaned/Verbatim toggle rebuilds the whole
document by replaying them through the same deterministic pipeline. The Activity
panel word-diffs the two so you can see exactly what the rewrite removed.

Command parsing is local and deterministic — no LLM in the command loop, because
a spoken command has to behave identically every time. Each phrase carries an
anchor controlling where in an utterance it may match, so "the quote was
misattributed" stays prose, and "so heading two comes back as those two words"
does not shred the paragraph it sits in. Per-word confidences drive a heatmap
that underlines what the model was unsure about.

Zero npm dependencies — clone it and run `node server/index.js`. With no API key
it starts in Demo Mode and replays a scripted document, so it is fully explorable
without a key or a microphone. 140 tests, including a stand-in upstream that
asserts the multipart ordering and that the body genuinely arrives in pieces
over time.

---

**Bugs / Feedback**

Four notes from building against the Dictation API this week.

1. The endpoint is hard to find from outside the docs page. Searching for
   "AssemblyAI dictation API" surfaces the Sync STT product first, whose endpoint
   (sync.assemblyai.com/transcribe) has a similar request shape and the same
   keyterms_prompt parameter. I built an entire first version against the wrong
   service before catching it. The docs note that /v1/transcribe/stream still
   reaches the same handler and that there is no unversioned alias — exactly the
   right kind of note. A line in the Sync docs saying "if you want dictation, you
   want dictation.assemblyai.com" would have saved me a day.

2. The "Uploading while recording" section deserves to be far more prominent. It
   is the single most valuable property of this API and it sits three quarters
   down the page under a heading that reads like an optional optimisation. It is
   not an optimisation — it changes the architecture of anything built on it.

3. A browser-side note would help. The natural way to stream from a browser is
   fetch with a ReadableStream body, which silently requires HTTP/2 and is
   Chrome-only; over an HTTP/1.1 local server it fails with
   ERR_ALPN_NEGOTIATION_FAILED. "Call it over HTTP" implies a browser can do this
   directly, and it cannot without a proxy in front. One line in the docs would
   save people the same afternoon it cost me.

4. Minor: the hackathon announcement says 18 supported languages; the docs list
   19 codes (en, es, de, fr, it, pt, tr, nl, sv, no, da, fi, hi, vi, ar, he, ja,
   ur, zh).

Positive notes worth recording. Returning both `text` and `llm_response` rather
than only the rewrite is the right call — it makes the rewrite auditable, and it
is the only reason the Cleaned/Verbatim toggle in this project is possible.
Splitting `request_time_ms` from `sync_time_ms` lets you see the rewrite's cost
separately from transcription without instrumenting anything. And returning 404
for an invalid key is unusual enough that documenting it explicitly, as you do,
genuinely prevented a debugging detour.

**Which Dictation API capabilities does your project use?**
☑ Real-time dictation / live transcription
☑ Multi-language support (18 languages)
☑ Filler-word removal / clean output
☑ Custom vocabulary / other integration

*(All four are genuinely used: live streaming dictation uploaded during speech, a
language selector covering every supported code, the default llm_instruction
cleanup with a verbatim/cleaned diff view, and `keyterms_prompt` plus `stt_prompt`
as custom vocabulary and context.)*

**Tech stack / frameworks used**
Vanilla JavaScript (ES modules), Node 20 standard library only, Web Audio API +
AudioWorklet, chunked multipart streaming, zero npm dependencies. AssemblyAI
Dictation API (POST https://dictation.assemblyai.com/v1/transcribe/live).

**Source code repository link**
`[your GitHub URL]`

**Demo video link**
`[your video URL]`

**Live demo or hosted app link**
Runs locally — microphone access requires a secure context, and the repo is
designed to clone and run in one command with no key needed for Demo Mode.
