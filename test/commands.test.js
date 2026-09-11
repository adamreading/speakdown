import test from "node:test";
import assert from "node:assert/strict";

import { parseUtterance, normalise, KEYTERMS, COMMANDS } from "../public/js/commands.js";

/** Helper: flatten a parse into a compact shape that is easy to assert on. */
function shape(utterance, options) {
  return parseUtterance(utterance, options).map((segment) =>
    segment.type === "text" ? { text: segment.text } : { cmd: segment.command.id },
  );
}

test("normalise strips edge punctuation and folds smart quotes", () => {
  assert.equal(normalise("Heading two,"), "heading two");
  assert.equal(normalise("  “Quote” — here.  "), "quote - here");
  assert.equal(normalise("don't"), "don't");
});

test("a bare command utterance yields only a command", () => {
  assert.deepEqual(shape("new paragraph"), [{ cmd: "paragraph" }]);
  assert.deepEqual(shape("Scratch that."), [{ cmd: "scratch" }]);
});

test("command prefix splits from the content that follows", () => {
  assert.deepEqual(shape("Heading two, what this is"), [
    { cmd: "h2" },
    { text: "what this is" },
  ]);
});

test("command suffix splits from the content before it", () => {
  assert.deepEqual(shape("that is the end of the section new paragraph"), [
    { text: "that is the end of the section" },
    { cmd: "paragraph" },
  ]);
});

test("multi-word commands match mid-utterance", () => {
  assert.deepEqual(shape("first point new paragraph second point"), [
    { text: "first point" },
    { cmd: "paragraph" },
    { text: "second point" },
  ]);
});

test("strict single words do NOT match mid-utterance", () => {
  // This is the case that makes or breaks the grammar: "quote" in the middle of
  // a sentence is prose, not a blockquote command.
  assert.deepEqual(shape("the quote was misattributed to him"), [
    { text: "the quote was misattributed to him" },
  ]);
  assert.deepEqual(shape("she had a bold approach to the problem"), [
    { text: "she had a bold approach to the problem" },
  ]);
});

test("strict single words DO match at the boundaries", () => {
  assert.deepEqual(shape("quote"), [{ cmd: "quote" }]);
  assert.deepEqual(shape("heading the roadmap"), [{ cmd: "h2" }, { text: "the roadmap" }]);
  assert.deepEqual(shape("we shipped it on time bold"), [
    { text: "we shipped it on time" },
    { cmd: "bold" },
  ]);
});

test("heading phrases only match at the start of an utterance", () => {
  // The case that caught this: dictating a document *about* dictation.
  assert.deepEqual(
    shape("so heading two comes back as those two words, not heading too"),
    [{ text: "so heading two comes back as those two words, not heading too" }],
  );
  // Still works where headings are actually spoken.
  assert.deepEqual(shape("heading two the honest bits"), [
    { cmd: "h2" },
    { text: "the honest bits" },
  ]);
  // And not at the end either, unlike boundary-anchored commands.
  assert.deepEqual(shape("the next section is a heading three"), [
    { text: "the next section is a heading three" },
  ]);
});

test("block commands match at either boundary but not in the middle", () => {
  assert.deepEqual(shape("bullet list keyterms prompting"), [
    { cmd: "bullet" },
    { text: "keyterms prompting" },
  ]);
  assert.deepEqual(shape("that wraps it up code block"), [
    { text: "that wraps it up" },
    { cmd: "code" },
  ]);
  assert.deepEqual(shape("we discussed the code block at length yesterday"), [
    { text: "we discussed the code block at length yesterday" },
  ]);
});

test("anywhere-anchored commands still match mid-utterance", () => {
  assert.deepEqual(shape("first thought new paragraph second thought"), [
    { text: "first thought" },
    { cmd: "paragraph" },
    { text: "second thought" },
  ]);
  assert.deepEqual(shape("that was wrong scratch that let me retry"), [
    { text: "that was wrong" },
    { cmd: "scratch" },
    { text: "let me retry" },
  ]);
});

test("longest phrase wins over a shorter overlapping one", () => {
  // "heading two" must beat the strict bare "heading".
  assert.deepEqual(shape("heading two"), [{ cmd: "h2" }]);
  assert.deepEqual(shape("heading three"), [{ cmd: "h3" }]);
  // "end code block" must beat "code block".
  assert.deepEqual(shape("end code block"), [{ cmd: "codeEnd" }]);
});

test("'strike that' is delete, not strikethrough", () => {
  // Fifty years of dictation convention. Getting this backwards would be a
  // genuinely destructive bug.
  assert.deepEqual(shape("strike that"), [{ cmd: "scratch" }]);
  assert.deepEqual(shape("strikethrough that"), [{ cmd: "strike" }]);
});

test("digit and word heading forms are equivalent", () => {
  assert.deepEqual(shape("heading 2 overview"), [{ cmd: "h2" }, { text: "overview" }]);
  assert.deepEqual(shape("heading two overview"), [{ cmd: "h2" }, { text: "overview" }]);
});

test("punctuation commands are ignored unless enabled", () => {
  assert.deepEqual(shape("comma"), [{ text: "comma" }]);
  assert.deepEqual(shape("comma", { punctuation: true }), [{ cmd: "comma" }]);
});

test("empty and whitespace input parse to nothing", () => {
  assert.deepEqual(shape(""), []);
  assert.deepEqual(shape("   "), []);
});

test("KEYTERMS covers every declared phrase and fits the API budget", () => {
  const declared = new Set();
  for (const cmd of COMMANDS) {
    for (const phrase of [...(cmd.phrases || []), ...(cmd.strictPhrases || [])]) {
      declared.add(phrase.toLowerCase());
    }
  }
  assert.equal(KEYTERMS.length, declared.size, "keyterms should be the deduplicated phrase list");

  // keyterms_prompt is capped at 2048 characters across all terms.
  const totalChars = KEYTERMS.reduce((acc, term) => acc + term.length + 1, 0);
  assert.ok(totalChars < 2048, `keyterms total ${totalChars} chars, budget is 2048`);
});

test("every command declares at least one phrase and a label", () => {
  for (const cmd of COMMANDS) {
    const phrases = [...(cmd.phrases || []), ...(cmd.strictPhrases || [])];
    assert.ok(phrases.length > 0, `${cmd.id} has no phrases`);
    assert.ok(cmd.label, `${cmd.id} has no label`);
    assert.ok(cmd.group, `${cmd.id} has no group`);
  }
});

test("command ids are unique", () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
