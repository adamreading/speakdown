/**
 * A small markdown renderer, plus a source highlighter.
 *
 * Speakdown ships with zero npm dependencies, so that a judge (or you, in six
 * months) can clone it and run `node server/index.js` with nothing else
 * installed. This is the one place that costs us something: about 150 lines
 * instead of `import { marked }`.
 *
 * It covers exactly the subset Speakdown can produce — headings, paragraphs,
 * three list flavours, blockquotes, fenced code, rules, and inline emphasis,
 * code, strikethrough and links. All HTML is escaped before any markup is
 * generated, so dictating "<script>" produces text, not a script.
 */

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPE[c]);
}

/**
 * Markdown -> HTML.
 * @param {string} markdown
 * @returns {string}
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Heading
    let m = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      out.push(`<h${level}>${renderInline(m[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote — consume the run
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    // Task list — checked before plain bullets, since it is a bullet too
    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const im = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        const checked = im[1].toLowerCase() === "x";
        items.push(
          `<li class="task"><input type="checkbox" disabled${checked ? " checked" : ""}> ` +
            `<span>${renderInline(im[2])}</span></li>`,
        );
        i++;
      }
      out.push(`<ul class="task-list">${items.join("")}</ul>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]) && !/^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const collected = [lines[i].replace(/^\s*[-*+]\s+/, "")];
        i++;
        // Indented continuation lines belong to the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          collected.push(lines[i].trim());
          i++;
        }
        items.push(`<li>${renderInline(collected.join(" "))}</li>`);
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      const startAt = parseInt(line.match(/^\s*(\d+)/)[1], 10);
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const collected = [lines[i].replace(/^\s*\d+[.)]\s+/, "")];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
          collected.push(lines[i].trim());
          i++;
        }
        items.push(`<li>${renderInline(collected.join(" "))}</li>`);
      }
      const startAttr = startAt !== 1 ? ` start="${startAt}"` : "";
      out.push(`<ol${startAttr}>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph — consume until a blank line or a block-level marker
    const body = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|```|-{3,}$|\*{3,}$|_{3,}$)/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      body.push(lines[i]);
      i++;
    }
    // Two trailing spaces = hard break.
    const html = body
      .map((l, idx) => (idx < body.length - 1 && /\s{2}$/.test(l) ? renderInline(l.trimEnd()) + "<br>" : renderInline(l.trim())))
      .join(" ");
    out.push(`<p>${html}</p>`);
  }

  return out.join("\n");
}

/**
 * Inline markup. Code spans are extracted first so their contents are never
 * re-parsed as emphasis.
 */
export function renderInline(text) {
  let escaped = escapeHtml(text);

  // Code spans are lifted out before any other inline rule runs, so their
  // contents are never re-parsed as emphasis. The placeholder uses angle
  // brackets deliberately: escapeHtml has already stripped every `<` and `>`
  // from the text, so this token cannot collide with anything the user said,
  // and it carries no emphasis characters for the rules below to chew on.
  const codeSpans = [];
  escaped = escaped.replace(/(`+)([^`]+?)\1/g, (_, _ticks, body) => {
    codeSpans.push(body);
    return `<<CODESPAN${codeSpans.length - 1}>>`;
  });

  escaped = escaped
    // Links: [label](url) — only http(s) and mailto, to avoid javascript: URLs.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, href) => {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    // Bare URLs
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => {
      return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    })
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");

  return escaped.replace(/<<CODESPAN(\d+)>>/g, (_, n) => `<code>${codeSpans[Number(n)]}</code>`);
}

// ---------------------------------------------------------------------------
// Source highlighting
// ---------------------------------------------------------------------------

/**
 * Render raw markdown as highlighted HTML for the source pane: markdown syntax
 * is dimmed, and any word the transcription model was unsure about gets a
 * dotted underline so you know where to look when proof-reading.
 *
 * @param {string} markdown
 * @param {Set<string>} lowConfidence Lowercased bare words.
 * @returns {string}
 */
export function highlightSource(markdown, lowConfidence = new Set()) {
  const lines = String(markdown).split("\n");
  return lines
    .map((line) => {
      if (!line) return '<span class="src-line"> </span>';

      let prefix = "";
      let rest = line;

      const marker = line.match(/^(\s*(?:#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s|>\s?|```.*$|-{3,}$))/);
      if (marker) {
        prefix = `<span class="src-syntax">${escapeHtml(marker[1])}</span>`;
        rest = line.slice(marker[1].length);
      }

      const body = markWords(rest, lowConfidence);
      return `<span class="src-line">${prefix}${body}</span>`;
    })
    // Joined with nothing, not "\n": `.src-line` is already a block, and inside
    // a `white-space: pre-wrap` container a literal newline between the spans
    // would render as a *second* line break, doubling the document's height.
    .join("");
}

function markWords(text, lowConfidence) {
  if (!text) return "";
  // Split keeping delimiters so inline markers stay visible.
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*|[^\p{L}\p{N}]+/gu, (chunk) => {
    if (/^[\p{L}\p{N}]/u.test(chunk)) {
      const bare = chunk.toLowerCase().replace(/^\W+|\W+$/g, "");
      if (lowConfidence.has(bare)) {
        return `<span class="src-lowconf" title="Low transcription confidence">${escapeHtml(chunk)}</span>`;
      }
      return escapeHtml(chunk);
    }
    // Emphasis / code markers get the dim treatment.
    if (/^[*_`~#>[\]()]+$/.test(chunk)) {
      return `<span class="src-syntax">${escapeHtml(chunk)}</span>`;
    }
    return escapeHtml(chunk);
  });
}
