# Speakdown

**Dictate the prose. Speak the formatting.**

A voice-native markdown editor built on the AssemblyAI Sync (Dictation) API. You
talk; structured markdown appears. Say "heading two" and you get a heading. Say
"bullet list" and you get a list. Say "scratch that" and the last thing you said
disappears. No keyboard, no toolbar, no mouse.

![Speakdown](docs/screenshot.png)

Built for AssemblyAI's Voice Hackathon Week, September 2026.

---

## Run it

```bash
git clone <this-repo> && cd speakdown
node server/index.js
```

That is the whole setup. **Zero npm dependencies** — no `npm install`, no
lockfile, no build step. Node 20 or newer is the only requirement.

Open <http://localhost:3000>. With no API key it starts in **Demo Mode** and
replays a scripted dictation with realistic latencies, so you can see the entire
editor work without a key or a microphone. Press *Play demo*.

For real dictation:

```bash
cp .env.example .env     # then paste your key into ASSEMBLYAI_API_KEY
node server/index.js
```

Press the mic and talk. Chrome, Edge, Firefox and Safari 14.1+ all work;
`localhost` counts as a secure context, so microphone access is granted normally.

```bash
npm test                 # 126 tests, no dependencies, ~0.6s
```

---

## How it works

```
  microphone
      │
      ▼
  AudioWorklet ──► Float32 frames (raw, on the audio render thread)
      │
      ▼
  voice-activity segmenter ──► one clip per utterance (+300 ms pre-roll)
      │
      ▼
  WAV encoder ──────────────► 16 kHz mono 16-bit PCM
      │
      ▼
  POST /api/transcribe ─────► local proxy attaches the API key
      │
      ▼
  sync.assemblyai.com/transcribe  (one HTTP round trip, ~180 ms observed)
      │
      ▼
  filler removal ──► command parser ──► document model ──► markdown + preview
```

The interesting problem here is not streaming. The Sync endpoint takes a clip
and returns a finished transcript in one request — no WebSocket, no polling, no
job to manage. The interesting problem is deciding **where one utterance ends**,
and making a spoken command land in the document as structure rather than as the
words "heading two".

### The three accuracy levers

Speakdown uses every accuracy option the Sync API offers, and the first one is
what makes the whole concept viable:

| Config field | What Speakdown sends | Why |
|---|---|---|
| `keyterms_prompt` | All 29 command phrases, on every request | Without it, "heading two" transcribes as "heading too" and "block quote" as "black quote". The parser then never sees a command. This single parameter is the difference between a working product and a party trick. |
| `prompt` | A description of the audio as markdown dictation with spoken formatting commands | Biases the model towards the command register and document prose. |
| `conversation_context` | A rolling window of the last 8 utterances of **prose only** | Keeps proper nouns and terminology consistent across a document instead of treating every clip as a cold start. Commands are deliberately excluded — feeding them back would teach the model to expect formatting words where they do not belong. |

Per-word confidences from the response drive the **confidence heatmap**: words
the model was unsure about get a dotted amber underline in the source pane, so
you know where to look when proof-reading. It is a per-term minimum across the
document, not a per-occurrence record — that is the question you actually want
answered when checking dictated text.

---

## The command grammar

29 commands, parsed locally and deterministically. There is no LLM in this loop
on purpose: a spoken command must behave identically every single time, and an
extra inference step would add latency and non-determinism to the one part that
has to be predictable.

| Say | Get |
|---|---|
| "heading one" / "title" | `# Heading` |
| "heading two" / "subheading" / "heading" | `## Heading` |
| "heading three" | `### Heading` |
| "new paragraph" | Blank line, fresh block |
| "new line" | Soft break inside the block |
| "bullet list" / "next bullet" | `- item` |
| "numbered list" / "next number" | `1. item` (auto-increments) |
| "checklist" / "new task" | `- [ ] item` |
| "block quote" | `> quoted` |
| "code block" … "end code block" | Fenced block, captured verbatim |
| "divider" / "horizontal rule" | `---` |
| "bold that" / "italic that" / "code that" | Wraps what you just said |
| "strikethrough that" | `~~struck~~` |
| **"scratch that"** / "delete that" / "strike that" | Removes the last thing you said |
| "bring that back" | Re-applies what you scratched |
| "stop dictation" | Hands the mic back |

Spoken punctuation ("comma", "full stop", "open quote") is available but **off by
default**, because the model already punctuates prose well and doubling up makes
a mess. Turn it on in Settings.

### Where commands are allowed to match

Every phrase carries an anchor, and this is the part that took the most
iteration:

- **anywhere** — "new paragraph", "scratch that". Distinctive enough to be safe,
  and people genuinely tack these on mid-flow.
- **boundary** — only at the start or end of an utterance. Lists, quotes, code
  fences, emphasis.
- **start** — only at the very start. Headings.

Headings earn the tightest anchor because of a sentence in this project's own
demo script: *"so heading two comes back as those two words, not heading too"*.
A naive parser turns that into a heading mid-sentence and shreds the paragraph.
Dictating a document *about* dictation is exactly when this bites. In practice
you always pause before a heading anyway, which starts a new utterance.

Separately, short phrases that occur in ordinary prose — "heading", "quote",
"bold", "comma" — are marked strict, forcing at least boundary anchoring.
Without that, "the quote was misattributed to him" silently becomes a
blockquote.

**"Strike that" means delete, not strikethrough.** That has been the dictation
convention for fifty years, and getting it backwards would be destructive. Say
"strikethrough that" for `~~text~~`.

---

## Decisions worth explaining

**The browser will not give you 16-bit audio.** The Sync API accepts "WAV or raw
PCM S16LE — 16-bit only". `MediaRecorder`, the obvious API, produces webm/opus,
which the endpoint rejects. So Speakdown captures raw Float32 frames through an
`AudioWorklet`, resamples to 16 kHz, converts to Int16 and writes the 44-byte
RIFF header itself. This is where a naive integration breaks, so it lives in one
small module ([`public/js/wav.js`](public/js/wav.js)) with its own tests —
including that out-of-range samples clamp rather than wrap, which is an easy way
to turn quiet speech into loud static.

Downsampling uses block averaging for integer ratios (48 kHz → 16 kHz, the
common case) rather than naive decimation. Dropping samples without a low-pass
filter aliases high frequencies down into the speech band and measurably hurts
accuracy.

**Requests are concurrent; application is ordered.** Speaking three sentences in
a row puts three requests in flight at once, because waiting for each response
before sending the next would make dictation feel like a walkie-talkie. But they
are *applied* strictly in the order they were spoken, via a sequence number and
a pending map. Without that, a fast short clip overtakes a slow long one and the
document comes out scrambled. This is the single most likely way a dictation app
built on a synchronous endpoint goes wrong, and it only shows up when you talk
quickly.

**300 ms of pre-roll.** The segmenter retains audio from *before* speech was
detected. Without it every utterance loses its first consonant and "bullet list"
arrives as "ullet list". Voice activity detection also uses an adaptive noise
floor (a fixed threshold works in a quiet room and fails next to a laptop fan)
and hysteresis, so a dip mid-word does not split one utterance into two. The
meter in the dock draws the live threshold, which makes the segmenter's decisions
visible when a room is behaving badly.

**One undo snapshot per utterance.** "Scratch that" should undo the last thing
you *said*, not the last internal operation, regardless of how many commands
that utterance contained. A pure-edit utterance deliberately does not snapshot
first — otherwise the undo pops the snapshot just pushed and nothing appears to
happen.

**Headings are single-line.** Once a heading has its text, the next utterance
opens a paragraph. Without this, "heading two, what this is" followed by a
sentence produces one enormous heading containing the whole paragraph.

**The API key never reaches the browser.** The tiny Node proxy holds it and
builds the multipart request upstream. It also validates the WAV header locally
and rejects clips outside the documented 80 ms – 120 s range before spending a
request on a call that would fail.

---

## Notes on the Dictation API

Written up honestly, including what did not work.

**What is genuinely good.** One request, one transcript, no state to manage — for
dictation this is simply the right shape, and it removes an entire class of
reconnect and partial-result bugs that a streaming integration has to handle.
Observed round trips in this project ran roughly 150–220 ms end to end from a UK
connection, of which about 110–180 ms was `request_time_ms`. Having the server's
own processing time in the response is a small thing that saved real debugging
effort — it tells you immediately whether a slow request was the model or the
network. `keyterms_prompt` made a large, obvious difference to command
recognition; it is the reason this project works at all.

**Three things I would flag as feedback:**

1. *The hackathon brief says filler words are "auto-removed for clean output".*
   The Sync API reference documents no such option, and transcripts come back
   with "um", "uh" and "you know" intact. Speakdown strips them client-side
   instead and counts what it removed. Either the docs are missing a feature or
   the announcement is describing one that is not there.

2. *The brief says 18 languages; the API reference lists 19 language codes*
   (en, es, de, fr, it, pt, nl, tr, sv, no, da, fi, hi, vi, ar, he, ja, ur, zh).
   Minor, but it is the kind of thing that makes a developer second-guess which
   document is current.

3. *No speaker diarization on this endpoint.* Expected for a dictation API, and
   correct for the use case — but worth stating plainly in the Sync docs, because
   `speaker_labels` exists on the pre-recorded endpoint and the natural
   assumption is that it carries over.

**One documentation gap:** a `/warm` endpoint is described in AssemblyAI's own
blog post about this API as a way to pre-establish the TLS connection when the
user presses record, but it does not appear in the API reference. Speakdown does
not call it, because I could not verify it from the documentation. If it is
supported it belongs in the reference, since connection setup is a meaningful
slice of perceived latency for short clips.

---

## Limitations

Stated plainly, because a demo that hides these is not much use to anyone.

The voice command grammar is English-only. The transcription works in all 19
supported languages and you can dictate prose in any of them, but the command
phrases are English words. Localising the grammar is a per-language table, not a
rewrite, but it is not done.

Nested structure is not supported. The document model is a flat list of blocks,
because every nesting scheme I tried made spoken commands ambiguous — a bullet
list inside a quote inside a list gives "bullet list" three possible meanings.
Consecutive list items are grouped at serialisation time, which produces correct
markdown without the model needing to represent a tree.

The confidence heatmap is per-term, not per-occurrence. If a word appears three
times and the model was unsure once, all three are underlined.

Spoken punctuation and filler removal are heuristics operating on text, not
audio. "Aggressive" filler removal will occasionally delete a meaningful
"actually", which is exactly why it is not the default.

Very long single utterances are cut at 20 seconds, well below the API's 120 s
ceiling. You lose nothing — the clip is sent and a new one starts — but a
sentence can be split across two requests, and the join is not always perfect.

Utterance segmentation is tuned for a reasonably quiet room with a close
microphone. It degrades in a noisy open-plan office, which is a limitation of
energy-based voice activity detection rather than of the API.

---

## Layout

```
server/index.js           HTTP server, static files, API proxy, WAV validation
public/index.html         The editor shell
public/css/app.css        All styling
public/js/
  app.js                  Wiring, ordered concurrency, UI state, level meter
  recorder.js             Microphone capture and voice-activity segmentation
  wav.js                  Resampling, Int16 conversion, RIFF encoding
  capture-worklet.js      AudioWorklet processor (audio render thread)
  dictation.js            Live API client + scripted demo client
  commands.js             The voice command grammar and keyterm vocabulary
  pipeline.js             Transcript -> document (DOM-free, fully tested)
  doc.js                  Block document model, undo, markdown serialisation
  text.js                 Filler removal, fragment joining, emphasis wrapping
  markdown.js             Markdown renderer and source highlighter
test/                     126 tests across all of the above
```

The pipeline lives apart from `app.js` deliberately: it holds all the
interesting behaviour, and keeping it free of DOM access means the test suite
exercises the real code rather than a reimplementation of it. The end-to-end
test runs the entire demo script through the real pipeline and asserts on the
resulting markdown.

---

## Licence

MIT. See [LICENSE](LICENSE).
