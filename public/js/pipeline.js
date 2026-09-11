/**
 * The transcript-to-document pipeline.
 *
 * One transcript in, a mutated document and a report out. It lives apart from
 * app.js deliberately: this is the part with all the interesting behaviour
 * (filler stripping, command dispatch, undo semantics), and keeping it free of
 * DOM access means the test suite exercises the real code rather than a
 * reimplementation of it.
 */

import { stripFillers } from "./text.js";
import { parseUtterance } from "./commands.js";

/**
 * @typedef {object} ApplyReport
 * @property {Array} segments          Parsed segments, in order.
 * @property {Array} commands          Commands that fired.
 * @property {number} removed          Fillers stripped.
 * @property {boolean} appliedText     Whether any prose reached the document.
 * @property {string} prose            The prose portion, commands stripped out.
 * @property {string[]} warnings       Non-fatal problems worth surfacing.
 * @property {string|null} control     A control command the caller must act on.
 */

/**
 * Apply one transcript to a document.
 *
 * @param {import('./doc.js').SpeakdownDoc} doc
 * @param {string} rawText Text exactly as the API returned it.
 * @param {object} [options]
 * @param {'off'|'standard'|'aggressive'} [options.fillerLevel]
 * @param {boolean} [options.punctuation]
 * @returns {ApplyReport}
 */
export function applyTranscript(doc, rawText, options = {}) {
  const { fillerLevel = "standard", punctuation = false } = options;

  const report = {
    segments: [],
    commands: [],
    removed: 0,
    appliedText: false,
    prose: "",
    warnings: [],
    control: null,
  };

  const raw = String(rawText || "").trim();
  if (!raw) return report;

  const { text: cleaned, removed } = stripFillers(raw, fillerLevel);
  report.removed = removed;

  const segments = parseUtterance(cleaned, { punctuation });
  report.segments = segments;
  if (!segments.length) return report;

  // An utterance that is nothing but edit commands ("scratch that") has to undo
  // the PREVIOUS utterance, so it must not snapshot first — otherwise the undo
  // pops the snapshot we just pushed and nothing visible happens.
  const pureEdit = segments.every((s) => s.type === "command" && s.command.kind === "edit");
  if (!pureEdit) doc.snapshot();

  for (const segment of segments) {
    if (segment.type === "text") {
      doc.appendText(segment.text);
      report.appliedText = true;
      continue;
    }

    const cmd = segment.command;
    report.commands.push(cmd);

    switch (cmd.kind) {
      case "block":
        doc.setBlockType(cmd.blockType);
        break;

      case "break":
        if (cmd.blockType === "br") doc.softBreak();
        else doc.newBlock("p");
        break;

      case "inline":
        if (!doc.wrapLastInsert(cmd.marker)) {
          report.warnings.push("Nothing to wrap yet");
        }
        break;

      case "edit":
        if (cmd.op === "undo") {
          if (!doc.undo()) report.warnings.push("Nothing left to scratch");
        } else if (!doc.redo()) {
          report.warnings.push("Nothing to bring back");
        }
        break;

      case "punct":
        doc.appendPunctuation(cmd.text);
        break;

      case "control":
        report.control = cmd.op;
        break;
    }
  }

  doc.stats.commands += report.commands.length;
  doc.stats.fillersRemoved += removed;
  doc.stats.utterances++;

  // The prose with command phrases removed. Reported separately because a
  // caller wants the words that became document content, not the words that
  // became structure.
  report.prose = segments
    .filter((s) => s.type === "text")
    .map((s) => s.text)
    .join(" ");

  return report;
}
