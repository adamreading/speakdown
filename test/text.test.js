import test from "node:test";
import assert from "node:assert/strict";

import {
  stripFillers,
  appendFragment,
  wrapRange,
  capitaliseFirst,
  tidy,
  wordCount,
} from "../public/js/text.js";

test("standard filler removal drops disfluencies and counts them", () => {
  const { text, removed } = stripFillers(
    "Speakdown is a um voice native editor, you know, for dictation.",
    "standard",
  );
  assert.ok(!/\bum\b/i.test(text), text);
  assert.ok(!/you know/i.test(text), text);
  assert.equal(removed, 2);
  assert.match(text, /^Speakdown is a voice native editor/);
});

test("standard level leaves discourse markers alone", () => {
  const { text } = stripFillers("It basically works like actually magic", "standard");
  assert.match(text, /basically/);
  assert.match(text, /actually/);
});

test("aggressive level removes discourse markers too", () => {
  const { text, removed } = stripFillers("It basically works, actually.", "aggressive");
  assert.ok(!/basically/i.test(text), text);
  assert.ok(!/actually/i.test(text), text);
  assert.ok(removed >= 2);
});

test("longest filler phrase wins over its prefix", () => {
  const { text } = stripFillers("uh huh that is right", "standard");
  assert.ok(!/uh huh/i.test(text), text);
  assert.match(text, /that is right/);
});

test("filler removal never empties an utterance that is only a filler", () => {
  const { text, removed } = stripFillers("um", "standard");
  assert.equal(text, "um");
  assert.equal(removed, 0);
});

test("filler removal is a no-op when off", () => {
  const input = "um so you know whatever";
  const { text, removed } = stripFillers(input, "off");
  assert.equal(text, input);
  assert.equal(removed, 0);
});

test("filler removal does not eat words that merely contain a filler", () => {
  const { text } = stripFillers("The umbrella is likely erroneous", "aggressive");
  assert.match(text, /umbrella/);
  assert.match(text, /likely/);
  assert.match(text, /erroneous/);
});

test("removing a filler after a full stop recapitalises the next sentence", () => {
  const { text } = stripFillers(
    "It returns in one round trip. You know, no websocket, no polling.",
    "standard",
  );
  assert.match(text, /round trip\. No websocket/);
});

test("recapitalisation leaves common abbreviations alone", () => {
  const { text } = stripFillers("Use a sync call, um, e.g. this one.", "standard");
  assert.match(text, /e\.g\. this one/, text);
});

test("tidy collapses whitespace and orphaned punctuation", () => {
  assert.equal(tidy("hello   world ,  now."), "hello world, now.");
  assert.equal(tidy(", leading comma"), "leading comma");
});

test("appendFragment capitalises after a sentence end", () => {
  assert.equal(appendFragment("First sentence.", "second one"), "First sentence. Second one");
});

test("appendFragment does not capitalise mid-sentence", () => {
  assert.equal(appendFragment("the quick brown", "fox jumps"), "the quick brown fox jumps");
});

test("appendFragment capitalises the first fragment of an empty block", () => {
  assert.equal(appendFragment("", "hello there"), "Hello there");
  assert.equal(appendFragment("   ", "hello there"), "Hello there");
});

test("appendFragment tucks punctuation against the previous word", () => {
  assert.equal(appendFragment("wait", ", actually"), "wait, actually");
});

test("capitaliseFirst skips leading non-letters", () => {
  assert.equal(capitaliseFirst("“hello"), "“Hello");
  assert.equal(capitaliseFirst("123 go"), "123 go");
  assert.equal(capitaliseFirst(""), "");
});

test("wrapRange wraps the trailing fragment", () => {
  assert.equal(wrapRange("The point is latency", 13, "**"), "The point is **latency**");
});

test("wrapRange keeps trailing punctuation outside the emphasis", () => {
  assert.equal(wrapRange("The point is latency.", 13, "**"), "The point is **latency**.");
});

test("wrapRange toggles rather than nesting", () => {
  const once = wrapRange("say **bold**", 4, "**");
  assert.equal(once, "say bold");
});

test("wrapRange is a no-op for an out-of-range start", () => {
  assert.equal(wrapRange("hello", 99, "**"), "hello");
  assert.equal(wrapRange("hello", -1, "**"), "hello");
});

test("wordCount handles empty and multi-space input", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("   "), 0);
  assert.equal(wordCount("one  two   three"), 3);
});
