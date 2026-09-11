/**
 * The document model.
 *
 * A document is a flat list of blocks. Flat, not nested — dictation is a linear
 * act, and every nesting feature I tried made spoken commands ambiguous
 * ("bullet list" inside a quote inside a list: which level closes?). Consecutive
 * list blocks are grouped at serialisation time, which gives correct markdown
 * without the model having to represent the tree.
 *
 * Undo is snapshot-based. Every utterance snapshots the whole document before
 * applying, so "scratch that" is one pop regardless of how many operations the
 * utterance contained. Documents here are a few KB at most, so the memory cost
 * is irrelevant next to the correctness win.
 */

import { appendFragment, wrapRange, wordCount, capitaliseFirst } from "./text.js";

let nextId = 1;

const BLOCK_PREFIX = {
  p: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  ul: "- ",
  task: "- [ ] ",
  quote: "> ",
};

const LIST_TYPES = new Set(["ul", "ol", "task"]);
const HEADING_TYPES = new Set(["h1", "h2", "h3"]);

export class SpeakdownDoc {
  constructor() {
    this.blocks = [makeBlock("p")];
    this.history = [];
    this.future = [];
    this.lastInsert = null; // { blockId, start }
    /** word (lowercased) -> { min, count } — powers the confidence heatmap */
    this.confidence = new Map();
    this.stats = { words: 0, fillersRemoved: 0, commands: 0, utterances: 0 };
  }

  // -- history -------------------------------------------------------------

  snapshot() {
    this.history.push(this.#serialiseState());
    if (this.history.length > 200) this.history.shift();
    this.future.length = 0;
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.future.push(this.#serialiseState());
    this.#restoreState(prev);
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.history.push(this.#serialiseState());
    this.#restoreState(next);
    return true;
  }

  #serialiseState() {
    return JSON.stringify({
      blocks: this.blocks,
      lastInsert: this.lastInsert,
      stats: this.stats,
    });
  }

  #restoreState(json) {
    const state = JSON.parse(json);
    this.blocks = state.blocks;
    this.lastInsert = state.lastInsert;
    this.stats = state.stats;
    if (!this.blocks.length) this.blocks = [makeBlock("p")];
  }

  // -- block access --------------------------------------------------------

  get current() {
    return this.blocks[this.blocks.length - 1];
  }

  /**
   * Where the next dictated words will land, for drawing a caret.
   *
   *   newLine  — the caret sits on a line of its own (the current block is
   *              still empty, or a soft break is pending) rather than at the
   *              end of the last rendered line
   *   prefix   — the markdown the new line will start with ("- ", "## ", "3. ",
   *              continuation indent after "new line"), so the ghost line reads
   *              like the markdown that is about to appear
   *   gap      — a blank line separates it from the previous block
   */
  cursor() {
    const cur = this.current;
    const prev = this.blocks[this.blocks.length - 2];
    const text = cur.text.replace(/\s+$/, "");
    const pendingBreak = /\n$/.test(cur.text) && text.length > 0;

    // A finished heading or a rule never takes more words: the next utterance
    // opens a fresh paragraph below it (see appendText).
    if ((HEADING_TYPES.has(cur.type) && text) || cur.type === "hr") {
      return { newLine: true, prefix: "", gap: true };
    }
    if (text && !pendingBreak) return { newLine: false, prefix: "", gap: false };

    let prefix = BLOCK_PREFIX[cur.type] ?? "";
    if (cur.type === "ol") {
      let n = 1;
      for (let i = this.blocks.length - 2; i >= 0 && this.blocks[i].type === "ol"; i--) n++;
      prefix = `${n}. `;
    }
    if (cur.type === "code" || cur.type === "hr") prefix = "";

    if (pendingBreak) {
      // Continuation line inside the same block: list items indent to the
      // content column, quotes repeat their marker, paragraphs start flush.
      const cont = cur.type === "quote" ? "> " : LIST_TYPES.has(cur.type) ? " ".repeat(prefix.length) : "";
      return { newLine: true, prefix: cont, gap: false };
    }

    const prevHasText = Boolean(prev && (prev.text.trim() || prev.type === "hr" || prev.type === "code"));
    const sameList = prev && LIST_TYPES.has(cur.type) && prev.type === cur.type;
    return { newLine: true, prefix, gap: prevHasText && !sameList };
  }

  /**
   * Apply a block type. If the current block is still empty we retype it in
   * place; otherwise we open a new block. This is what makes "heading two"
   * followed by the heading text behave the way people expect, while
   * "...end of sentence. new paragraph. bullet list" does not leave an empty
   * paragraph behind.
   */
  setBlockType(type) {
    if (type === "hr") {
      if (this.current.type === "p" && !this.current.text) this.blocks.pop();
      this.blocks.push(makeBlock("hr"));
      this.blocks.push(makeBlock("p"));
      this.lastInsert = null;
      return this.current;
    }

    const cur = this.current;
    const isEmpty = !cur.text.trim();

    // Saying "bullet list" again while already on an empty bullet should not
    // stack empty items.
    if (isEmpty) {
      cur.type = type;
      this.lastInsert = null;
      return cur;
    }

    // Closing a code fence returns to prose.
    this.blocks.push(makeBlock(type));
    this.lastInsert = null;
    return this.current;
  }

  /** New block, used by "new paragraph". */
  newBlock(type = "p") {
    const cur = this.current;
    if (!cur.text.trim() && cur.type === type) {
      this.lastInsert = null;
      return cur;
    }
    // Leaving a code fence, or a list, returns to a plain paragraph.
    this.blocks.push(makeBlock(type));
    this.lastInsert = null;
    return this.current;
  }

  /** Soft line break inside the current block. */
  softBreak() {
    const cur = this.current;
    if (cur.text.trim()) cur.text = cur.text.replace(/\s+$/, "") + "\n";
    this.lastInsert = null;
    return cur;
  }

  /**
   * Append dictated prose to the current block.
   * Records where the fragment started so "bold that" knows what to wrap.
   */
  appendText(text) {
    const cur = this.current;

    // Headings are single-line by nature: once one has its text, the next
    // utterance is body copy, not more heading. Without this, dictating
    // "heading two, what this is" and then a sentence produces one enormous
    // heading containing the whole paragraph.
    if (HEADING_TYPES.has(cur.type) && cur.text.trim()) {
      this.blocks.push(makeBlock("p"));
    } else if (cur.type === "hr") {
      this.blocks.push(makeBlock("p"));
    }

    const target = this.current;

    if (target.type === "code") {
      // Code blocks are verbatim: no capitalisation, newline per utterance.
      const start = target.text.length ? target.text.length + 1 : 0;
      target.text = target.text ? target.text + "\n" + text : text;
      this.lastInsert = { blockId: target.id, start };
      return target;
    }

    const before = target.text;
    const merged = appendFragment(before, text);
    // Where the new fragment actually landed, accounting for the joiner and
    // any capitalisation the join applied.
    const start = findFragmentStart(merged, before);
    target.text = merged;
    this.lastInsert = { blockId: target.id, start };
    return target;
  }

  /** Append a punctuation mark tight against the preceding word. */
  appendPunctuation(mark) {
    const cur = this.current;
    if (!cur.text && /^[.,;:!?…]$/.test(mark)) return cur; // nothing to punctuate
    const open = /[“(\[{]/.test(mark);
    cur.text = open ? appendFragment(cur.text, mark) : cur.text.replace(/\s+$/, "") + mark;
    return cur;
  }

  /** Wrap the most recently dictated fragment in a markdown marker. */
  wrapLastInsert(marker) {
    if (!this.lastInsert) return false;
    const block = this.blocks.find((b) => b.id === this.lastInsert.blockId);
    if (!block) return false;
    const before = block.text;
    block.text = wrapRange(block.text, this.lastInsert.start, marker);
    return block.text !== before;
  }

  // -- confidence ----------------------------------------------------------

  /**
   * Fold per-word confidences from an API response into the document's term
   * map. This is a per-term minimum, not a per-occurrence record: it answers
   * "which words was the model unsure about in this document", which is the
   * question you actually want answered when proof-reading dictation.
   */
  recordWords(words) {
    if (!Array.isArray(words)) return;
    for (const w of words) {
      const key = String(w.text || "").toLowerCase().replace(/^\W+|\W+$/g, "");
      if (!key) continue;
      const conf = typeof w.confidence === "number" ? w.confidence : 1;
      const entry = this.confidence.get(key);
      if (entry) {
        entry.min = Math.min(entry.min, conf);
        entry.count++;
      } else {
        this.confidence.set(key, { min: conf, count: 1 });
      }
    }
  }

  /** Words whose best observed confidence sits below the threshold. */
  lowConfidenceTerms(threshold = 0.75) {
    const out = [];
    for (const [word, entry] of this.confidence) {
      if (entry.min < threshold) out.push({ word, confidence: entry.min, count: entry.count });
    }
    return out.sort((a, b) => a.confidence - b.confidence);
  }

  // -- serialisation -------------------------------------------------------

  /** Render the document as markdown. */
  toMarkdown() {
    const lines = [];
    let olCounter = 0;
    let previousType = null;

    for (const block of this.blocks) {
      const text = block.text.replace(/\s+$/, "");

      if (block.type === "hr") {
        if (lines.length) lines.push("");
        lines.push("---", "");
        previousType = "hr";
        olCounter = 0;
        continue;
      }

      if (block.type === "code") {
        if (lines.length) lines.push("");
        lines.push("```", ...(text ? text.split("\n") : []), "```", "");
        previousType = "code";
        olCounter = 0;
        continue;
      }

      if (!text) {
        // Trailing empty block is the live cursor; skip it in output.
        continue;
      }

      if (LIST_TYPES.has(block.type)) {
        // Blank line before a list starts, but not between its items.
        if (previousType !== block.type && lines.length && lines[lines.length - 1] !== "") {
          lines.push("");
        }
        if (block.type !== "ol") olCounter = 0;
        const prefix = block.type === "ol" ? `${++olCounter}. ` : BLOCK_PREFIX[block.type];
        const [first, ...rest] = text.split("\n");
        lines.push(prefix + first);
        // Continuation lines indent to the list item's content column.
        for (const line of rest) lines.push(" ".repeat(prefix.length) + line);
        previousType = block.type;
        continue;
      }

      olCounter = 0;
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");

      const prefix = BLOCK_PREFIX[block.type] ?? "";
      const bodyLines = text.split("\n");
      if (block.type === "quote") {
        for (const line of bodyLines) lines.push("> " + line);
      } else if (block.type.startsWith("h")) {
        lines.push(prefix + bodyLines.join(" "));
      } else {
        // Hard break in markdown is two trailing spaces.
        lines.push(bodyLines.join("  \n"));
      }
      lines.push("");
      previousType = block.type;
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  /**
   * Parse markdown back into blocks. Needed so the Source pane can be edited by
   * hand, and so you can paste an existing draft and carry on dictating.
   */
  static fromMarkdown(markdown) {
    const doc = new SpeakdownDoc();
    doc.blocks = [];

    const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
    let inCode = false;
    let codeLines = [];
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const block = makeBlock("p");
      block.text = paragraph.join("\n").trim();
      if (block.text) doc.blocks.push(block);
      paragraph = [];
    };

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) {
          const block = makeBlock("code");
          block.text = codeLines.join("\n");
          doc.blocks.push(block);
          codeLines = [];
          inCode = false;
        } else {
          flushParagraph();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        continue;
      }

      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        flushParagraph();
        const block = makeBlock(`h${m[1].length}`);
        block.text = m[2].trim();
        doc.blocks.push(block);
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        doc.blocks.push(makeBlock("hr"));
      } else if ((m = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.*)$/))) {
        flushParagraph();
        const block = makeBlock("task");
        block.text = m[1].trim();
        doc.blocks.push(block);
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushParagraph();
        const block = makeBlock("ul");
        block.text = m[1].trim();
        doc.blocks.push(block);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushParagraph();
        const block = makeBlock("ol");
        block.text = m[1].trim();
        doc.blocks.push(block);
      } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
        const last = doc.blocks[doc.blocks.length - 1];
        if (last && last.type === "quote" && !paragraph.length) {
          last.text += "\n" + m[1].trim();
        } else {
          flushParagraph();
          const block = makeBlock("quote");
          block.text = m[1].trim();
          doc.blocks.push(block);
        }
      } else {
        paragraph.push(line.trim());
      }
    }

    if (inCode && codeLines.length) {
      const block = makeBlock("code");
      block.text = codeLines.join("\n");
      doc.blocks.push(block);
    }
    flushParagraph();

    // Always leave a live cursor block at the end.
    if (!doc.blocks.length || doc.blocks[doc.blocks.length - 1].text) {
      doc.blocks.push(makeBlock("p"));
    }

    doc.stats.words = wordCount(doc.toMarkdown().replace(/[#>`*_\-[\]]/g, " "));
    return doc;
  }

  /** Drop everything, keeping a single empty block. */
  clear() {
    this.blocks = [makeBlock("p")];
    this.lastInsert = null;
  }

  isEmpty() {
    return this.blocks.length === 1 && !this.blocks[0].text.trim();
  }
}

function makeBlock(type) {
  return { id: `b${nextId++}`, type, text: "" };
}

/**
 * Locate where the appended fragment begins in the merged string.
 * appendFragment may capitalise or drop a joining space, so a plain
 * `before.length` is not reliable.
 */
function findFragmentStart(merged, before) {
  const trimmed = before.trimEnd();
  if (!trimmed) return 0;
  if (merged.startsWith(trimmed)) {
    let i = trimmed.length;
    // Skip the joiner, whether that was a space or a preserved line break.
    while (i < merged.length && /\s/.test(merged[i])) i++;
    return i;
  }
  return Math.min(trimmed.length, merged.length);
}

export { LIST_TYPES, HEADING_TYPES, capitaliseFirst };
