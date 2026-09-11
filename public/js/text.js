/**
 * Text hygiene: filler removal and the small joining rules that make dictated
 * fragments read like written prose.
 *
 * A note on filler removal, because the hackathon brief and the docs disagree:
 * the announcement says filler words are "auto-removed for clean output", but
 * the Sync API reference documents no such option, and transcripts come back
 * with disfluencies intact. So Speakdown strips them client-side and counts
 * what it removed — which has the side benefit of being tunable, auditable and
 * visible in the UI, rather than an opaque server-side behaviour.
 */

/** Pure disfluencies. Safe to remove — they carry no meaning in writing. */
const STANDARD_FILLERS = [
  "um", "umm", "ummm", "uh", "uhh", "uhhh", "erm", "ermm", "er", "err",
  "ah", "ahh", "eh", "mm", "mmm", "hmm", "hm", "mhm", "uh huh",
  "you know", "i mean", "sort of", "kind of", "you see",
];

/**
 * Discourse markers. Often meaningful, so these are opt-in — removing
 * "actually" changes the sentence when the contrast was the point.
 */
const AGGRESSIVE_FILLERS = [
  "like", "basically", "actually", "literally", "obviously", "essentially",
  "right", "so yeah", "i guess", "or whatever", "at the end of the day",
  "to be honest", "if that makes sense", "does that make sense",
];

const cache = new Map();

/**
 * @param {'off'|'standard'|'aggressive'} level
 * @returns {RegExp|null}
 */
function fillerPattern(level) {
  if (level === "off") return null;
  if (cache.has(level)) return cache.get(level);

  const words = level === "aggressive"
    ? [...STANDARD_FILLERS, ...AGGRESSIVE_FILLERS]
    : STANDARD_FILLERS;

  // Longest first so "uh huh" wins over "uh".
  const alternatives = [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");

  // Word-boundary anchored, optionally trailing a comma the speaker paused on.
  const pattern = new RegExp(`\\b(?:${alternatives})\\b\\s*,?\\s*`, "giu");
  cache.set(level, pattern);
  return pattern;
}

/**
 * Strip fillers and report how many were dropped.
 * @param {string} text
 * @param {'off'|'standard'|'aggressive'} level
 * @returns {{text: string, removed: number}}
 */
export function stripFillers(text, level = "standard") {
  const pattern = fillerPattern(level);
  if (!pattern || !text) return { text: text || "", removed: 0 };

  let removed = 0;
  let out = text.replace(pattern, (match, offset, whole) => {
    // Do not strip a filler that is the entire utterance — if someone dictates
    // only "um", leaving an empty string is more confusing than leaving it.
    if (match.trim().replace(/,$/, "").length === whole.trim().length) return match;
    removed++;
    // Preserve a single separating space when the filler sat between words.
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    return before && after && /\S/.test(before) && /\S/.test(after) ? " " : "";
  });

  out = tidy(out);
  // Removing a filler can expose a lowercase word at the start of a sentence:
  // "…round trip. You know, no websocket" becomes "…round trip. no websocket".
  if (removed) out = recapitaliseSentences(out);
  return { text: out, removed };
}

/**
 * Capitalise the first letter after sentence-ending punctuation.
 *
 * Only fires on a full stop followed by whitespace and a lowercase letter, and
 * skips the common abbreviations that would otherwise be mangled.
 */
export function recapitaliseSentences(text) {
  const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|approx|no|fig|cf|al|dr|mr|mrs|ms|prof|st|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;

  return String(text).replace(
    /([.!?…])(\s+)(\p{Ll})/gu,
    (match, punct, space, letter, offset, whole) => {
      const preceding = whole.slice(Math.max(0, offset - 12), offset + 1);
      if (ABBREVIATIONS.test(preceding)) return match;
      return punct + space + letter.toLocaleUpperCase();
    },
  );
}

/** Collapse the whitespace and stray punctuation that removal leaves behind. */
export function tidy(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\s*(?=[,.;:!?])/g, "")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

/**
 * Append a dictated fragment to existing block text with sensible spacing and
 * capitalisation.
 *
 * @param {string} existing
 * @param {string} addition
 * @returns {string}
 */
export function appendFragment(existing, addition) {
  const add = String(addition).trim();
  if (!add) return existing;

  const base = String(existing || "");
  if (!base.trim()) return capitaliseFirst(add);

  // A soft line break is a hard boundary: keep the newline and start the next
  // line fresh. Without this the trimEnd below would swallow it and "new line"
  // would silently do nothing.
  if (/\n[ \t]*$/.test(base)) {
    return base.replace(/[ \t]+$/, "") + capitaliseFirst(add);
  }

  const endsOpen = /[([{“"'`]$/.test(base.trimEnd());
  const startsPunct = /^[,.;:!?)\]}”"']/.test(add);
  const endsSentence = /[.!?…]["”')\]]?$/.test(base.trimEnd());

  let joiner = " ";
  if (startsPunct || endsOpen) joiner = "";

  const next = endsSentence && !startsPunct ? capitaliseFirst(add) : add;
  return base.trimEnd() + joiner + next;
}

/**
 * Capitalise the opening letter, skipping only leading whitespace and opening
 * punctuation.
 *
 * Deliberately does NOT hunt for the first letter anywhere in the string: a
 * fragment beginning with a figure ("3 reasons this failed") should keep its
 * lowercase word, not become "3 Reasons this failed".
 */
export function capitaliseFirst(text) {
  const s = String(text);
  const m = s.match(/^[\s"'“‘(\[{*_`>-]*/u);
  const i = m ? m[0].length : 0;
  if (i >= s.length) return s;
  const ch = s[i];
  if (!/\p{L}/u.test(ch)) return s;
  return s.slice(0, i) + ch.toLocaleUpperCase() + s.slice(i + 1);
}

/**
 * Wrap the trailing `length` characters of a string in a markdown marker.
 * Used by "bold that" / "italic that" / "code that".
 *
 * @param {string} text Full block text.
 * @param {number} start Index where the last fragment began.
 * @param {string} marker e.g. "**"
 * @returns {string}
 */
export function wrapRange(text, start, marker) {
  if (start < 0 || start >= text.length) return text;
  const head = text.slice(0, start);
  const body = text.slice(start);

  // Keep trailing punctuation outside the emphasis — "**word**." not "**word.**"
  const m = body.match(/^(.*?)([\s,.;:!?…]*)$/su);
  const core = (m ? m[1] : body).trim();
  const tail = m ? m[2] : "";
  if (!core) return text;

  // Already wrapped? Toggle off rather than nesting.
  if (core.startsWith(marker) && core.endsWith(marker) && core.length > marker.length * 2) {
    return head + core.slice(marker.length, -marker.length) + tail;
  }

  return head + marker + core + marker + tail;
}

export function wordCount(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export { STANDARD_FILLERS, AGGRESSIVE_FILLERS };
