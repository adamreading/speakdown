import test from "node:test";
import assert from "node:assert/strict";

import { SpeakdownDoc } from "../public/js/doc.js";

test("a fresh document is empty and serialises to almost nothing", () => {
  const doc = new SpeakdownDoc();
  assert.ok(doc.isEmpty());
  assert.equal(doc.toMarkdown().trim(), "");
});

test("appendText fills the current block", () => {
  const doc = new SpeakdownDoc();
  doc.appendText("hello there");
  assert.equal(doc.toMarkdown().trim(), "Hello there");
});

test("setBlockType retypes an empty block instead of stacking one", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("h2");
  doc.setBlockType("h2");
  doc.appendText("Overview");
  assert.equal(doc.toMarkdown().trim(), "## Overview");
  assert.equal(doc.blocks.length, 1);
});

test("setBlockType opens a new block once the current one has content", () => {
  const doc = new SpeakdownDoc();
  doc.appendText("Intro prose.");
  doc.setBlockType("h2");
  doc.appendText("Next section");
  assert.equal(doc.toMarkdown().trim(), "Intro prose.\n\n## Next section");
});

test("a heading does not swallow the utterance that follows it", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("h2");
  doc.appendText("what this is");
  doc.appendText("Speakdown is a voice native editor.");
  assert.equal(
    doc.toMarkdown().trim(),
    "## What this is\n\nSpeakdown is a voice native editor.",
  );
});

test("a heading still accepts its own text in the same utterance", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("h1");
  doc.appendText("the title");
  assert.equal(doc.toMarkdown().trim(), "# The title");
});

test("a bullet keeps accumulating across utterances, unlike a heading", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("ul");
  doc.appendText("one long point");
  doc.appendText("that continues here");
  assert.equal(doc.toMarkdown().trim(), "- One long point that continues here");
});

test("consecutive bullets group without blank lines between them", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("ul");
  doc.appendText("first");
  doc.setBlockType("ul");
  doc.appendText("second");
  doc.setBlockType("ul");
  doc.appendText("third");
  assert.equal(doc.toMarkdown().trim(), "- First\n- Second\n- Third");
});

test("numbered lists auto-increment and reset after other content", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("ol");
  doc.appendText("one");
  doc.setBlockType("ol");
  doc.appendText("two");
  doc.setBlockType("p");
  doc.appendText("A paragraph.");
  doc.setBlockType("ol");
  doc.appendText("restarted");

  const md = doc.toMarkdown();
  assert.match(md, /1\. One\n2\. Two/);
  assert.match(md, /1\. Restarted/);
});

test("task blocks render as markdown checkboxes", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("task");
  doc.appendText("record the demo");
  assert.equal(doc.toMarkdown().trim(), "- [ ] Record the demo");
});

test("code blocks are verbatim, uncapitalised, one line per utterance", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("code");
  doc.appendText("node server/index.js");
  doc.appendText("npm test");
  assert.equal(doc.toMarkdown().trim(), "```\nnode server/index.js\nnpm test\n```");
});

test("leaving a code block returns to prose", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("code");
  doc.appendText("run it");
  doc.newBlock("p");
  doc.appendText("then read the output");
  const md = doc.toMarkdown();
  assert.match(md, /```\nrun it\n```/);
  assert.match(md, /Then read the output/);
});

test("hr emits a rule and leaves a fresh paragraph behind it", () => {
  const doc = new SpeakdownDoc();
  doc.appendText("Above.");
  doc.setBlockType("hr");
  doc.appendText("Below.");
  assert.equal(doc.toMarkdown().trim(), "Above.\n\n---\n\nBelow.");
});

test("quote blocks prefix every line", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("quote");
  doc.appendText("first line");
  doc.softBreak();
  doc.appendText("second line");
  assert.equal(doc.toMarkdown().trim(), "> First line\n> Second line");
});

test("wrapLastInsert emboldens only the most recent fragment", () => {
  const doc = new SpeakdownDoc();
  doc.appendText("The thing that matters is");
  doc.appendText("latency");
  assert.ok(doc.wrapLastInsert("**"));
  assert.equal(doc.toMarkdown().trim(), "The thing that matters is **latency**");
});

test("wrapLastInsert reports failure when there is nothing to wrap", () => {
  const doc = new SpeakdownDoc();
  assert.equal(doc.wrapLastInsert("**"), false);
});

test("undo restores the previous snapshot", () => {
  const doc = new SpeakdownDoc();
  doc.appendText("Keep this.");
  doc.snapshot();
  doc.appendText("Lose this.");
  assert.match(doc.toMarkdown(), /Lose this/);
  assert.ok(doc.undo());
  assert.equal(doc.toMarkdown().trim(), "Keep this.");
  assert.doesNotMatch(doc.toMarkdown(), /Lose this/);
});

test("redo reapplies what undo removed", () => {
  const doc = new SpeakdownDoc();
  doc.snapshot();
  doc.appendText("Provisional.");
  doc.undo();
  assert.ok(doc.redo());
  assert.match(doc.toMarkdown(), /Provisional/);
});

test("undo on an empty history reports failure", () => {
  const doc = new SpeakdownDoc();
  assert.equal(doc.undo(), false);
});

test("recordWords tracks the minimum confidence per term", () => {
  const doc = new SpeakdownDoc();
  doc.recordWords([
    { text: "AssemblyAI", confidence: 0.9 },
    { text: "assemblyai,", confidence: 0.4 },
    { text: "latency", confidence: 0.99 },
  ]);
  const low = doc.lowConfidenceTerms(0.75);
  assert.equal(low.length, 1);
  assert.equal(low[0].word, "assemblyai");
  assert.equal(low[0].confidence, 0.4);
  assert.equal(low[0].count, 2);
});

test("recordWords tolerates missing or malformed input", () => {
  const doc = new SpeakdownDoc();
  doc.recordWords(undefined);
  doc.recordWords([{ text: "" }, {}, { text: "ok" }]);
  assert.equal(doc.lowConfidenceTerms(0.75).length, 0);
});

test("fromMarkdown round-trips every block type Speakdown produces", () => {
  const original = [
    "# Title",
    "",
    "## Section",
    "",
    "A paragraph of prose.",
    "",
    "- First bullet",
    "- Second bullet",
    "",
    "1. One",
    "2. Two",
    "",
    "- [ ] A task",
    "",
    "> A quotation",
    "",
    "```",
    "node server/index.js",
    "```",
    "",
    "---",
    "",
  ].join("\n");

  const doc = SpeakdownDoc.fromMarkdown(original);
  const round = doc.toMarkdown();

  for (const expected of [
    "# Title",
    "## Section",
    "A paragraph of prose.",
    "- First bullet",
    "- Second bullet",
    "1. One",
    "2. Two",
    "- [ ] A task",
    "> A quotation",
    "node server/index.js",
    "---",
  ]) {
    assert.ok(round.includes(expected), `missing after round trip: ${expected}\n---\n${round}`);
  }
});

test("fromMarkdown always leaves a live cursor block at the end", () => {
  const doc = SpeakdownDoc.fromMarkdown("# Just a heading");
  const last = doc.blocks[doc.blocks.length - 1];
  assert.equal(last.text, "");
  // ...and dictation continues into it as a paragraph.
  doc.appendText("continuing here");
  assert.match(doc.toMarkdown(), /# Just a heading\n\nContinuing here/);
});

test("fromMarkdown on empty input yields an empty document", () => {
  const doc = SpeakdownDoc.fromMarkdown("");
  assert.ok(doc.isEmpty());
});

test("clear resets to a single empty block", () => {
  const doc = new SpeakdownDoc();
  doc.setBlockType("h1");
  doc.appendText("Something");
  doc.clear();
  assert.ok(doc.isEmpty());
});
