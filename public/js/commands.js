/**
 * The voice command grammar.
 *
 * Speakdown's whole premise is that you should not have to touch a keyboard to
 * produce structured markdown. That needs two things working together:
 *
 *   1. A deterministic local parser (this file) that turns recognised words
 *      into document operations. No LLM — a spoken command should behave
 *      identically every single time, and an LLM in this loop would add
 *      latency and non-determinism to the one part that must be predictable.
 *
 *   2. The same vocabulary fed back to the API as `keyterms_prompt`. This is
 *      the part that actually makes it work. Without it, "heading two" comes
 *      back as "heading too", "block quote" as "black quote", and the parser
 *      never sees the command. Keyterm prompting moves these from roughly
 *      coin-flip to reliable.
 *
 * Matching rules
 * --------------
 * Every phrase carries an anchor saying where in an utterance it is allowed to
 * match. This is the difference between a grammar that works and one that
 * sabotages your prose:
 *
 *   anywhere  "new paragraph", "scratch that" — people genuinely tack these on
 *             mid-flow, and the phrasing is distinctive enough to be safe.
 *   boundary  Only at the very start or end of an utterance, or as the whole
 *             thing. Lists, quotes, code fences, emphasis.
 *   start     Only at the very start. Headings.
 *
 * Headings earn the tightest anchor because of sentences like "so heading two
 * comes back as those words, not heading too" — dictating a document *about*
 * dictation is exactly when a mid-utterance match bites, and in practice you
 * always pause before a heading anyway, which starts a new utterance.
 *
 * On top of the anchor, short phrases that also occur in ordinary prose
 * ("heading", "quote", "bold", "comma") are marked `strict`, which forces at
 * least `boundary` regardless of what the command's kind would otherwise
 * allow. Without it, "the quote was misattributed" would produce a blockquote.
 */

/** @typedef {'block'|'break'|'inline'|'edit'|'punct'|'control'} CommandKind */

export const COMMANDS = [
  // --- Structure -----------------------------------------------------------
  {
    id: "h1",
    kind: "block",
    blockType: "h1",
    label: "Heading 1",
    group: "Structure",
    hint: "Top-level title",
    phrases: ["heading one", "heading 1", "title", "top heading"],
  },
  {
    id: "h2",
    kind: "block",
    blockType: "h2",
    label: "Heading 2",
    group: "Structure",
    hint: "Section heading — also what bare “heading” gives you",
    phrases: ["heading two", "heading 2", "subheading", "sub heading", "section heading"],
    strictPhrases: ["heading"],
  },
  {
    id: "h3",
    kind: "block",
    blockType: "h3",
    label: "Heading 3",
    group: "Structure",
    hint: "Sub-section",
    phrases: ["heading three", "heading 3", "sub subheading"],
  },
  {
    id: "paragraph",
    kind: "break",
    blockType: "p",
    label: "New paragraph",
    group: "Structure",
    hint: "Blank line, fresh block",
    phrases: ["new paragraph", "new para", "next paragraph"],
    strictPhrases: ["paragraph"],
  },
  {
    id: "linebreak",
    kind: "break",
    blockType: "br",
    label: "New line",
    group: "Structure",
    hint: "Soft break inside the block",
    phrases: ["new line", "line break", "next line"],
  },
  {
    id: "bullet",
    kind: "block",
    blockType: "ul",
    label: "Bullet list",
    group: "Structure",
    hint: "Say it again for the next item",
    phrases: ["bullet list", "bulleted list", "bullet point", "new bullet", "next bullet"],
    strictPhrases: ["bullet"],
  },
  {
    id: "numbered",
    kind: "block",
    blockType: "ol",
    label: "Numbered list",
    group: "Structure",
    hint: "Auto-increments",
    phrases: ["numbered list", "number list", "ordered list", "numbered item", "next number"],
  },
  {
    id: "task",
    kind: "block",
    blockType: "task",
    label: "Checklist",
    group: "Structure",
    hint: "Markdown task item",
    phrases: ["checklist", "check list", "task list", "todo list", "to do list", "new task"],
  },
  {
    id: "quote",
    kind: "block",
    blockType: "quote",
    label: "Block quote",
    group: "Structure",
    hint: "Indented quotation",
    phrases: ["block quote", "blockquote"],
    strictPhrases: ["quote"],
  },
  {
    id: "code",
    kind: "block",
    blockType: "code",
    label: "Code block",
    group: "Structure",
    hint: "Fenced — say “end code block” to close",
    phrases: ["code block", "start code block", "begin code block"],
  },
  {
    id: "codeEnd",
    kind: "break",
    blockType: "p",
    label: "End code block",
    group: "Structure",
    hint: "Closes the fence",
    phrases: ["end code block", "end code", "close code block", "exit code block"],
  },
  {
    id: "hr",
    kind: "block",
    blockType: "hr",
    label: "Divider",
    group: "Structure",
    hint: "Horizontal rule",
    phrases: ["horizontal rule", "horizontal line", "section break", "divider", "thematic break"],
  },

  // --- Inline emphasis -----------------------------------------------------
  {
    id: "bold",
    kind: "inline",
    marker: "**",
    label: "Bold that",
    group: "Emphasis",
    hint: "Wraps what you just said",
    phrases: ["bold that", "make that bold", "embolden that"],
    strictPhrases: ["bold"],
  },
  {
    id: "italic",
    kind: "inline",
    marker: "*",
    label: "Italic that",
    group: "Emphasis",
    hint: "Wraps what you just said",
    phrases: ["italic that", "italicise that", "italicize that", "emphasise that", "emphasize that"],
    strictPhrases: ["italic", "italics"],
  },
  {
    id: "codeSpan",
    kind: "inline",
    marker: "`",
    label: "Code that",
    group: "Emphasis",
    hint: "Inline monospace",
    phrases: ["code that", "inline code", "monospace that"],
  },
  {
    id: "strike",
    kind: "inline",
    marker: "~~",
    label: "Strikethrough",
    group: "Emphasis",
    // Deliberately NOT "strike that" — in dictation that has meant "delete
    // that" for fifty years, and it is mapped to Scratch below.
    hint: "Say “strikethrough that”, not “strike that”",
    phrases: ["strikethrough that", "strike through that", "cross that out"],
  },

  // --- Editing -------------------------------------------------------------
  {
    id: "scratch",
    kind: "edit",
    op: "undo",
    label: "Scratch that",
    group: "Editing",
    hint: "Removes the last thing you said",
    phrases: ["scratch that", "delete that", "undo that", "strike that", "forget that", "cancel that"],
  },
  {
    id: "redo",
    kind: "edit",
    op: "redo",
    label: "Bring that back",
    group: "Editing",
    hint: "Re-applies what you scratched",
    phrases: ["bring that back", "redo that", "put that back"],
  },

  // --- Spoken punctuation (toggle) ----------------------------------------
  // The model already punctuates prose, so these are off by default and exist
  // for the cases where you need a specific mark the model will not infer.
  { id: "fullStop", kind: "punct", text: ".", label: "Full stop", group: "Punctuation", phrases: ["full stop"], strictPhrases: ["period"] },
  { id: "comma", kind: "punct", text: ",", label: "Comma", group: "Punctuation", phrases: [], strictPhrases: ["comma"] },
  { id: "question", kind: "punct", text: "?", label: "Question mark", group: "Punctuation", phrases: ["question mark"] },
  { id: "exclaim", kind: "punct", text: "!", label: "Exclamation mark", group: "Punctuation", phrases: ["exclamation mark", "exclamation point"] },
  { id: "colonMark", kind: "punct", text: ":", label: "Colon", group: "Punctuation", phrases: [], strictPhrases: ["colon"] },
  { id: "semicolon", kind: "punct", text: ";", label: "Semicolon", group: "Punctuation", phrases: [], strictPhrases: ["semicolon"] },
  { id: "emDash", kind: "punct", text: "—", label: "Em dash", group: "Punctuation", phrases: ["em dash", "long dash"] },
  { id: "ellipsis", kind: "punct", text: "…", label: "Ellipsis", group: "Punctuation", phrases: ["ellipsis", "dot dot dot"] },
  { id: "openQuote", kind: "punct", text: "“", label: "Open quote", group: "Punctuation", phrases: ["open quote", "open quotes"] },
  { id: "closeQuote", kind: "punct", text: "”", label: "Close quote", group: "Punctuation", phrases: ["close quote", "close quotes"] },

  // --- Control -------------------------------------------------------------
  {
    id: "stop",
    kind: "control",
    op: "stop",
    label: "Stop dictation",
    group: "Control",
    hint: "Hands the mic back",
    phrases: ["stop dictation", "stop listening", "pause dictation", "that's all for now"],
  },
];

const PUNCT_KINDS = new Set(["punct"]);

/** Anchor strength, most permissive first. */
const ANCHOR_RANK = { anywhere: 0, boundary: 1, start: 2 };

/** Default anchor per command kind, when the command does not state one. */
const KIND_ANCHOR = {
  block: "boundary",
  break: "anywhere",
  inline: "boundary",
  edit: "anywhere",
  punct: "anywhere",
  control: "boundary",
};

/** Commands whose anchor is tighter than their kind's default. */
const COMMAND_ANCHOR = {
  h1: "start",
  h2: "start",
  h3: "start",
};

/** The effective anchor for one indexed phrase: the most restrictive that applies. */
function anchorFor(command, strict) {
  const candidates = [
    KIND_ANCHOR[command.kind] || "boundary",
    COMMAND_ANCHOR[command.id],
    strict ? "boundary" : null,
  ].filter(Boolean);

  return candidates.reduce((a, b) => (ANCHOR_RANK[b] > ANCHOR_RANK[a] ? b : a));
}

/** Every phrase, flattened — this is what goes into `keyterms_prompt`. */
export const KEYTERMS = (() => {
  const seen = new Set();
  const out = [];
  for (const cmd of COMMANDS) {
    for (const phrase of [...(cmd.phrases || []), ...(cmd.strictPhrases || [])]) {
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(phrase);
    }
  }
  return out;
})();

/**
 * Sent as the `prompt` config field. Tells the model what kind of audio this is
 * so it biases towards document prose and recognises the command register.
 */
export const DICTATION_PROMPT = [
  "The speaker is dictating a written document and speaking formatting commands aloud.",
  "Transcribe formatting commands literally as spoken words, for example:",
  "heading two, new paragraph, bullet list, numbered list, block quote, code block,",
  "end code block, bold that, italic that, scratch that, divider, new line.",
  "Expect technical and product vocabulary, proper nouns, and British English spelling.",
  "Punctuate prose normally. Do not summarise, reorder or rephrase anything.",
].join(" ");

// ---------------------------------------------------------------------------
// Phrase index
// ---------------------------------------------------------------------------

/** first token -> candidate matches, longest phrase first */
const INDEX = (() => {
  const map = new Map();
  for (const cmd of COMMANDS) {
    const add = (phrase, strict) => {
      const tokens = normalise(phrase).split(" ").filter(Boolean);
      if (!tokens.length) return;
      const entry = { tokens, command: cmd, strict, anchor: anchorFor(cmd, strict) };
      const bucket = map.get(tokens[0]) || [];
      bucket.push(entry);
      map.set(tokens[0], bucket);
    };
    for (const p of cmd.phrases || []) add(p, false);
    for (const p of cmd.strictPhrases || []) add(p, true);
  }
  for (const bucket of map.values()) bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  return map;
})();

/**
 * Lowercase, fold smart punctuation, drop edge punctuation, collapse spaces.
 * Digits are kept so "heading 2" matches its literal phrase.
 */
export function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, ""))
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Split a transcribed utterance into an ordered list of text and command
 * segments.
 *
 * @param {string} utterance Raw text from the API.
 * @param {object} [options]
 * @param {boolean} [options.punctuation=false] Honour spoken punctuation commands.
 * @returns {Array<{type:'text', text:string} | {type:'command', command:object, phrase:string}>}
 */
export function parseUtterance(utterance, options = {}) {
  const { punctuation = false } = options;
  const tokens = tokenise(utterance);
  if (!tokens.length) return [];

  const segments = [];
  let buffer = [];

  const flushText = () => {
    if (!buffer.length) return;
    const text = buffer.join(" ").trim();
    if (text) segments.push({ type: "text", text });
    buffer = [];
  };

  let i = 0;
  while (i < tokens.length) {
    const match = matchAt(tokens, i, { punctuation });
    if (match) {
      flushText();
      segments.push({
        type: "command",
        command: match.command,
        phrase: match.tokens.join(" "),
      });
      i += match.tokens.length;
      continue;
    }
    buffer.push(tokens[i].raw);
    i++;
  }
  flushText();

  return segments;
}

/**
 * True when the utterance is nothing but commands — used to decide whether an
 * utterance contributed any prose.
 */
export function isPureCommand(segments) {
  return segments.length > 0 && segments.every((s) => s.type === "command");
}

function matchAt(tokens, index, { punctuation }) {
  const bucket = INDEX.get(tokens[index].norm);
  if (!bucket) return null;

  for (const entry of bucket) {
    if (PUNCT_KINDS.has(entry.command.kind) && !punctuation) continue;

    const end = index + entry.tokens.length;
    if (end > tokens.length) continue;

    let ok = true;
    for (let k = 0; k < entry.tokens.length; k++) {
      if (tokens[index + k].norm !== entry.tokens[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const atStart = index === 0;
    const atEnd = end === tokens.length;

    if (entry.anchor === "start" && !atStart) continue;
    if (entry.anchor === "boundary" && !atStart && !atEnd) continue;

    return entry;
  }
  return null;
}

function tokenise(text) {
  const raw = String(text).trim().split(/\s+/).filter(Boolean);
  return raw.map((token) => ({
    raw: token,
    norm: normalise(token),
  }));
}

/** Commands grouped for the UI palette, preserving declaration order. */
export function commandGroups() {
  const groups = new Map();
  for (const cmd of COMMANDS) {
    const list = groups.get(cmd.group) || [];
    list.push(cmd);
    groups.set(cmd.group, list);
  }
  return [...groups.entries()].map(([name, commands]) => ({ name, commands }));
}
