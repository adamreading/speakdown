import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown, renderInline, highlightSource, escapeHtml } from "../public/js/markdown.js";

test("headings render at the right level", () => {
  assert.equal(renderMarkdown("# One"), "<h1>One</h1>");
  assert.equal(renderMarkdown("## Two"), "<h2>Two</h2>");
  assert.equal(renderMarkdown("### Three"), "<h3>Three</h3>");
});

test("paragraphs are wrapped and blank lines separate them", () => {
  assert.equal(renderMarkdown("One.\n\nTwo."), "<p>One.</p>\n<p>Two.</p>");
});

test("two trailing spaces make a hard break", () => {
  assert.match(renderMarkdown("line one  \nline two"), /<br>/);
});

test("unordered lists group consecutive items", () => {
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("ordered lists render and honour a non-1 start", () => {
  assert.equal(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.match(renderMarkdown("3. c"), /<ol start="3">/);
});

test("task lists render disabled checkboxes with the right checked state", () => {
  const html = renderMarkdown("- [ ] todo\n- [x] done");
  assert.match(html, /class="task-list"/);
  assert.match(html, /<input type="checkbox" disabled> <span>todo<\/span>/);
  assert.match(html, /<input type="checkbox" disabled checked> <span>done<\/span>/);
});

test("a bullet is not mistaken for a task item", () => {
  const html = renderMarkdown("- plain bullet");
  assert.doesNotMatch(html, /checkbox/);
});

test("blockquotes render nested block content", () => {
  const html = renderMarkdown("> quoted line");
  assert.match(html, /<blockquote><p>quoted line<\/p><\/blockquote>/);
});

test("fenced code is escaped, not interpreted", () => {
  const html = renderMarkdown("```\n<script>alert(1)</script>\n```");
  assert.match(html, /<pre><code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a code fence language becomes a class", () => {
  assert.match(renderMarkdown("```js\nlet x = 1\n```"), /class="language-js"/);
});

test("horizontal rules render", () => {
  assert.equal(renderMarkdown("---"), "<hr>");
});

test("inline emphasis, strong, code and strikethrough all render", () => {
  assert.equal(renderInline("*em*"), "<em>em</em>");
  assert.equal(renderInline("**strong**"), "<strong>strong</strong>");
  assert.equal(renderInline("~~gone~~"), "<del>gone</del>");
  assert.equal(renderInline("`code`"), "<code>code</code>");
});

test("bold wins over italic on a double marker", () => {
  assert.equal(renderInline("**both**"), "<strong>both</strong>");
});

test("emphasis inside a code span is left alone", () => {
  assert.equal(renderInline("`a *b* c`"), "<code>a *b* c</code>");
});

test("underscores inside a word do not become emphasis", () => {
  assert.equal(renderInline("snake_case_name"), "snake_case_name");
});

test("links render, and only safe schemes are allowed", () => {
  assert.match(renderInline("[site](https://example.com)"), /<a href="https:\/\/example.com"/);
  // A javascript: URL must not become a link at all.
  const dangerous = renderInline("[click](javascript:alert(1))");
  assert.doesNotMatch(dangerous, /<a /);
  assert.doesNotMatch(dangerous, /javascript:/i.test(dangerous) ? /href/ : /<a /);
});

test("bare URLs autolink", () => {
  assert.match(renderInline("see https://example.com now"), /<a href="https:\/\/example.com"/);
});

test("all HTML in dictated text is escaped", () => {
  const html = renderMarkdown("A <b>bold</b> claim & an <img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /&amp;/);
});

test("escapeHtml covers the five dangerous characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("highlightSource dims markdown syntax", () => {
  const html = highlightSource("## Heading");
  assert.match(html, /class="src-syntax"/);
  assert.match(html, /Heading/);
});

test("highlightSource underlines only low-confidence words", () => {
  const html = highlightSource("the assemblyai endpoint", new Set(["assemblyai"]));
  assert.match(html, /class="src-lowconf"[^>]*>assemblyai</);
  assert.doesNotMatch(html, /class="src-lowconf"[^>]*>endpoint</);
});

test("highlightSource escapes its input", () => {
  const html = highlightSource("<script>bad()</script>");
  // No live tag survives. (The escaped text may be split across highlight
  // spans, so assert on the escaping rather than on a contiguous substring.)
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<\/script/i);
  assert.match(html, /&lt;script/);
  // Every angle bracket in the input is escaped somewhere in the output.
  const liveTags = html.replace(/<\/?span[^>]*>/g, "");
  assert.doesNotMatch(liveTags, /[<>]/);
});

test("highlightSource preserves blank lines as rows", () => {
  const html = highlightSource("a\n\nb");
  assert.equal((html.match(/class="src-line"/g) || []).length, 3);
});

test("highlightSource emits no literal newlines between line spans", () => {
  // The spans are display:block inside a pre-wrap container, so a newline
  // between them would render a second break and double the pane height.
  const html = highlightSource("# One\n\nTwo\n\n- Three");
  assert.doesNotMatch(html, /<\/span>\n/);
  assert.doesNotMatch(html, /\n/);
});
