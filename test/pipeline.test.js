import test from "node:test";
import assert from "node:assert/strict";

import { SpeakdownDoc } from "../public/js/doc.js";
import { applyTranscript } from "../public/js/pipeline.js";
import { DEMO_SCRIPT } from "../public/js/dictation.js";

/** Feed a list of transcripts through the pipeline, as dictation would. */
function dictate(utterances, options) {
  const doc = new SpeakdownDoc();
  const reports = [];
  for (const utterance of utterances) {
    reports.push(applyTranscript(doc, utterance, options));
  }
  return { doc, markdown: doc.toMarkdown(), reports };
}

test("a heading command and its content land in one block", () => {
  const { markdown } = dictate(["Heading two, project overview"]);
  assert.equal(markdown.trim(), "## Project overview");
});

test("prose accumulates across utterances into one paragraph", () => {
  const { markdown } = dictate([
    "This is the first sentence.",
    "And this is the second.",
  ]);
  assert.equal(markdown.trim(), "This is the first sentence. And this is the second.");
});

test("new paragraph opens a fresh block", () => {
  const { markdown } = dictate(["First thought.", "New paragraph", "Second thought."]);
  assert.equal(markdown.trim(), "First thought.\n\nSecond thought.");
});

test("a bullet run builds a list", () => {
  const { markdown } = dictate([
    "Bullet list, keyterms prompting",
    "Next bullet, deterministic parsing",
    "Next bullet, pre roll audio",
  ]);
  assert.equal(
    markdown.trim(),
    "- Keyterms prompting\n- Deterministic parsing\n- Pre roll audio",
  );
});

test("bold that wraps the whole previous utterance", () => {
  // "That" means what you just said, so a full-sentence utterance bolds whole.
  // The full stop stays outside the emphasis, which is the correct convention.
  const { markdown } = dictate(["This one matters most.", "Bold that"]);
  assert.equal(markdown.trim(), "**This one matters most**.");
});

test("bold that wraps only the last fragment when it was dictated separately", () => {
  // Pausing before the phrase is how you scope the emphasis to part of a line.
  const { markdown } = dictate([
    "The thing that actually matters here is",
    "latency",
    "Bold that",
  ]);
  assert.match(markdown, /The thing that actually matters here is \*\*latency\*\*/);
});

test("bold that toggles back off when repeated", () => {
  const { markdown } = dictate(["Emphasise me.", "Bold that", "Bold that"]);
  assert.equal(markdown.trim(), "Emphasise me.");
});

test("scratch that removes the previous utterance and nothing more", () => {
  const { markdown } = dictate([
    "Keep this sentence.",
    "New paragraph",
    "This one is a mistake.",
    "Scratch that",
  ]);
  assert.match(markdown, /Keep this sentence\./);
  assert.doesNotMatch(markdown, /mistake/);
});

test("scratch that on an empty document warns instead of throwing", () => {
  const { reports } = dictate(["Scratch that"]);
  assert.deepEqual(reports[0].warnings, ["Nothing left to scratch"]);
});

test("repeated scratch walks back through the history", () => {
  const { markdown } = dictate([
    "First.",
    "New paragraph",
    "Second.",
    "New paragraph",
    "Third.",
    "Scratch that",
    "Scratch that",
  ]);
  assert.match(markdown, /First\./);
  assert.doesNotMatch(markdown, /Third\./);
});

test("bring that back undoes a scratch", () => {
  const { markdown } = dictate([
    "Keep this.",
    "New paragraph",
    "Provisional sentence.",
    "Scratch that",
    "Bring that back",
  ]);
  assert.match(markdown, /Provisional sentence\./);
});

test("a code block captures utterances verbatim until it is closed", () => {
  const { markdown } = dictate([
    "Code block",
    "node server/index.js",
    "End code block",
    "That is all it takes.",
  ]);
  assert.match(markdown, /```\nnode server\/index\.js\n```/);
  assert.match(markdown, /That is all it takes\./);
});

test("fillers are stripped from prose and counted", () => {
  const { markdown, reports } = dictate([
    "Speakdown is a um voice native editor, you know, for dictation.",
  ]);
  assert.doesNotMatch(markdown, /\bum\b/i);
  assert.doesNotMatch(markdown, /you know/i);
  assert.equal(reports[0].removed, 2);
});

test("fillers are preserved when removal is off", () => {
  const { markdown, reports } = dictate(["It is um fine."], { fillerLevel: "off" });
  assert.match(markdown, /um/);
  assert.equal(reports[0].removed, 0);
});

test("a command word inside prose is not treated as a command", () => {
  const { markdown, reports } = dictate(["the quote he gave was bold in its claims"]);
  assert.equal(reports[0].commands.length, 0);
  assert.match(markdown, /the quote he gave was bold in its claims/i);
});

test("spoken punctuation is inert by default and active when enabled", () => {
  const off = dictate(["hello comma world"]);
  assert.match(off.markdown, /hello comma world/i);

  const on = dictate(["hello", "comma", "world"], { punctuation: true });
  assert.match(on.markdown, /Hello, world/);
});

test("the control command is reported rather than executed here", () => {
  const { reports } = dictate(["Stop dictation"]);
  assert.equal(reports[0].control, "stop");
});

test("stats accumulate across the session", () => {
  const { doc } = dictate([
    "Heading two, overview",
    "Some prose with um a filler.",
    "New paragraph",
  ]);
  assert.equal(doc.stats.utterances, 3);
  assert.equal(doc.stats.commands, 2); // h2 + paragraph
  assert.equal(doc.stats.fillersRemoved, 1);
});

test("empty and whitespace transcripts are no-ops", () => {
  const doc = new SpeakdownDoc();
  const report = applyTranscript(doc, "   ");
  assert.ok(doc.isEmpty());
  assert.equal(report.segments.length, 0);
  assert.equal(report.appliedText, false);
});

test("the full demo script produces a well-formed document", () => {
  // The end-to-end check: every scripted utterance through the real pipeline.
  // The demo entries carry both texts; the cleaned one is what the editor uses.
  const cleaned = DEMO_SCRIPT.map((entry) => entry.llm_response ?? entry.text);
  const { markdown, doc } = dictate(cleaned, { fillerLevel: "off" });

  assert.match(markdown, /^# Speakdown field notes/m);
  assert.match(markdown, /^## What this is/m);
  assert.match(markdown, /^## Uploading while you speak/m);
  assert.match(markdown, /^- Every command phrase goes into keyterms prompt/m);
  assert.match(markdown, /^> The rewrite is on by default/m);
  assert.match(markdown, /^- \[ \] Record the demo video/m);
  assert.match(markdown, /^---$/m);
  assert.match(markdown, /```\nnode server slash index dot js\n```/);
  assert.match(markdown, /\*\*when you stop talking[^*]*tail\*\*/i);

  // The script ends with a mistake and a "scratch that" — the mistake must be gone.
  assert.doesNotMatch(markdown, /This last sentence is a mistake/);

  // The script deliberately contains the sentence "so heading two comes back as
  // those two words, not heading too" — that phrase must survive as prose,
  // because a heading anchored to the start of an utterance should not fire in
  // the middle of one.
  assert.match(markdown, /so heading two comes back as those two words/i);

  // What must NOT happen is a command surviving as the opening of a block,
  // which is what an unconsumed command looks like.
  const leaked = markdown
    .split("\n")
    .map((line) => line.replace(/^(#{1,6}|[-*+]|\d+[.)]|>)\s*(\[[ x]\]\s*)?/i, "").trim())
    .find((line) =>
      /^(heading (one|two|three|[123])|bullet list|next bullet|numbered list|new paragraph|end code block|code block|scratch that|bold that|divider|checklist|new task|title)\b/i.test(
        line,
      ),
    );
  assert.equal(leaked, undefined, `command phrase leaked as block content: ${leaked}`);

  assert.ok(doc.stats.commands > 12, `expected a dozen-plus commands, got ${doc.stats.commands}`);
  // Disfluencies are gone because the API's rewrite removed them, not because
  // the local stripper ran — it is off here, as it is by default.
  assert.doesNotMatch(markdown, /\bum\b/i);
  assert.doesNotMatch(markdown, /\buh\b/i);
  assert.equal(doc.stats.fillersRemoved, 0);
});
