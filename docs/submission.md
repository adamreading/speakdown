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
Dictate the prose, speak the formatting — a voice-native markdown editor on the Sync Dictation API.

---

**Project description**

Speakdown is a markdown editor you drive entirely by voice. You dictate prose
normally and speak the formatting out loud: "heading two", "bullet list", "code
block", "bold that", "scratch that". Structured markdown appears live beside a
rendered preview. No keyboard, no toolbar.

It runs on the Sync Dictation API. The browser captures raw Float32 frames
through an AudioWorklet, a voice-activity segmenter closes an utterance after
~700 ms of silence (keeping 300 ms of pre-roll so the first phoneme survives),
and each clip is encoded to 16 kHz mono 16-bit WAV in the browser and POSTed to
`sync.assemblyai.com/transcribe` through a small local proxy that holds the API
key. One request, one transcript, ~180 ms observed round trip.

The part that makes it actually work is `keyterms_prompt`. All 29 command
phrases go into every request, because without them "heading two" transcribes as
"heading too" and the local parser never sees a command. That one parameter is
the difference between a working product and a party trick. `prompt` describes
the audio as markdown dictation, and `conversation_context` carries a rolling
window of the last eight utterances of prose so terminology stays consistent
across a document.

Command parsing is deliberately deterministic and local — no LLM in the command
loop, because a spoken command has to behave identically every time. Each phrase
carries an anchor controlling where in an utterance it may match, so "the quote
was misattributed" stays prose instead of becoming a blockquote, and "so heading
two comes back as those two words" does not shred the paragraph it sits in.
Per-word confidences from the response drive a heatmap that underlines the words
the model was unsure about, so you know where to look when proof-reading.

Requests fire concurrently but apply strictly in spoken order via a sequence
number, which is what stops a fast short clip overtaking a slow long one and
scrambling the document.

Zero npm dependencies — clone it and run `node server/index.js`. With no API key
it starts in Demo Mode and replays a scripted document with realistic latencies,
so it is fully explorable without a key or a microphone. 126 tests.

---

**Bugs / Feedback**

Three documentation issues and one gap, all found building against the Sync
endpoint this week.

1. The hackathon announcement says filler words are "auto-removed for clean
   output". The Sync API reference documents no such option, and transcripts come
   back with "um", "uh" and "you know" intact. Either the reference is missing a
   feature or the announcement describes one that does not exist. I ended up
   stripping fillers client-side and counting them.

2. The announcement says 18 supported languages; the API reference lists 19
   language codes (en, es, de, fr, it, pt, nl, tr, sv, no, da, fi, hi, vi, ar,
   he, ja, ur, zh). Minor, but it makes you second-guess which document is
   current.

3. A `/warm` endpoint is described in AssemblyAI's own blog post about this API
   as a way to pre-establish the TLS connection when the user presses record, but
   it does not appear in the API reference. Connection setup is a meaningful
   slice of perceived latency for short clips, so if it is supported it belongs
   in the reference. I did not use it because I could not verify it.

4. Suggestion: state plainly in the Sync docs that speaker diarization is not
   available on this endpoint. It is the right call for a dictation API, but
   `speaker_labels` exists on the pre-recorded endpoint and the natural
   assumption is that it carries over. I spent time checking.

Positive note worth recording: returning `request_time_ms` in the response is
genuinely useful. It tells you immediately whether a slow request was the model
or the network, which saved real debugging time. More APIs should do this.

---

**Which Dictation API capabilities does your project use?**
☑ Real-time dictation / live transcription
☑ Multi-language support (18 languages)
☑ Filler-word removal / clean output
☑ Custom vocabulary / other integration

*(All four are genuinely used: live utterance-by-utterance dictation, a language
selector covering every supported code, filler removal with a measured count,
and `keyterms_prompt` plus `conversation_context` as custom vocabulary.)*

**Tech stack / frameworks used**
Vanilla JavaScript (ES modules), Node 20 standard library only, Web Audio API +
AudioWorklet, zero npm dependencies. AssemblyAI Sync Dictation API
(`universal-3-5-pro`).

**Source code repository link**
`[your GitHub URL]`

**Demo video link**
`[your video URL]`

**Live demo or hosted app link**
Runs locally — microphone access requires a secure context, and the repo is
designed to clone and run in one command with no key needed for Demo Mode.
