# Demo video script

Target length: **90 seconds to 2 minutes.** Shorter is better than complete.
Judges watch a lot of these.

Record with the window at roughly 1600×900 so the rail, both panes and the dock
are all legible. Have `.env` set up with a real key first — the point is to show
live latency numbers, not Demo Mode.

---

## Before you hit record

- Run `node server/index.js` and confirm the mode pill says **LIVE**.
- Confirm *Upload* is set to "Stream while speaking" in Settings.
- Dismiss the Demo Mode banner if it is showing.
- Open the **Commands** tab in the right rail. It lights up as commands fire,
  which is the clearest visual proof that speech became structure.
- Close other tabs. A background tab stealing the mic mid-take is the most
  common way one of these recordings dies.
- Do one throwaway run to check your input level. Aim for the meter bars
  reaching two thirds height on normal speech.

---

## The take

Speak at a normal pace and **pause about a second between utterances**. Each
pause is what closes a clip and finishes the upload. Watch "wait after speech" in
the bottom right — it updates on every request, and that number is the star of
the demo.

> **Say:** "Title, Speakdown."
>
> *(An `# Speakdown` heading appears. The "heading one" row flashes in the rail.)*

> **Say:** "Heading two, what this is."

> **Say:** "Speakdown is a voice native markdown editor. You dictate the prose,
> and you speak the formatting out loud."
>
> *Point out, out loud, that the heading did not swallow the paragraph.*

> **Say:** "Heading two, uploading while you speak."

> **Say:** "The endpoint transcribes the audio it already has while the rest is
> still arriving."
>
> *This is the moment to point at the dock. Say the "wait after speech" number
> out loud, and say that the request opened when you started talking, not when
> you stopped.*

> **Say:** "Bullet list, every command phrase goes into keyterms prompt on every
> request."

> **Say:** "Next bullet, so heading two comes back as those two words."
>
> *This one matters. It proves the parser does not fire on a command phrase used
> mid-sentence. Say so.*

> **Say:** "Next bullet, one HTTP request, no websocket, no polling."

> **Say:** "New paragraph. The whole thing runs on the AssemblyAI dictation endpoint."

> **Say:** "Bold that."
>
> *(The sentence you just dictated becomes bold.)*

> **Say:** "This sentence is a mistake."

> **Say:** "Scratch that."
>
> *(It disappears. This always gets a reaction.)*

> **Say:** "Checklist, ship it."

Now the two moments that separate this from every other entry.

**One: the rewrite is visible.** Click **Verbatim** in the Markdown pane header.
The disfluencies you actually said reappear — the "um" and the "you know" that
the default cleanup removed. Click **Cleaned** and they vanish again. Then switch
the rail to **Activity** and point at a `rewrite removed N words` diff: the
struck-through words are exactly what `llm_response` dropped from `text`. Say
that the API returns both, and that this is what makes the rewrite auditable
rather than something you have to trust.

**Two: streaming is measurable.** Open **Settings**, switch *Upload* from "Stream
while speaking" to "Buffer, then send", and dictate one more sentence of similar
length. Watch "wait after speech" climb. Switch it back and dictate again. That
side-by-side is the strongest thirty seconds in the video — do not skip it.

Finish by hovering one of the amber dotted underlines in the source pane so the
"Low transcription confidence" tooltip shows.

---

## What to say over the top

Keep the narration to three points. Everything else is visible.

1. **It uploads while you talk.** The request opens when the voice-activity
   detector hears you start, not when you stop. Transcription overlaps with the
   rest of the sentence, so what you wait for at the end is only the tail. The
   buffered toggle proves it on camera.
2. **`keyterms_prompt` is why the commands land.** Without the command vocabulary
   pushed into every request, "heading two" comes back as "heading too" and the
   parser never sees a command. That one parameter is the difference between a
   working product and a party trick.
3. **The rewrite is auditable.** The API returns the verbatim transcript
   alongside the cleaned one, so the editor can show you both and diff them
   rather than asking you to trust a black box.

---

## If a take goes wrong

Do not restart. Say "scratch that" and carry on — recovering on camera is a
better demo than a clean take, because it shows the editing commands work under
pressure. The only reason to restart is if the mic drops entirely.

---

## Submission checklist

- [ ] Repo pushed to GitHub, public, with the README rendering correctly
- [ ] Screenshot visible in the README on GitHub
- [ ] `node server/index.js` verified working from a fresh clone in a temp dir
- [ ] `npm test` passes from that fresh clone
- [ ] `.env` **not** committed (`git log --all --full-history -- .env` is empty)
- [ ] Demo video uploaded (YouTube unlisted, Loom or Drive) and the link is
      publicly viewable — check it in a private window
- [ ] Form: project name, tagline, description, repo link, video link
- [ ] Form: tick *Real-time dictation*, *Multi-language support*,
      *Filler-word removal*, *Custom vocabulary / other integration* — all four
      are genuinely used
- [ ] Form: also submit the API feedback (discoverability vs the Sync product,
      the buried "uploading while recording" section, the missing browser
      HTTP/2 caveat, and the 18-vs-19 language count) — there is a $50 bounty
      for feedback and these are real findings; the write-up is in the README
      under "Notes on the Dictation API"
- [ ] Hosted link: `node server/invite.js create --hours 72 --label judges`
      on the host, paste the printed URL into the form, and check it in a
      private window shows the **LIVE** pill
