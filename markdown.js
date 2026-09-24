'use strict';

/* =====================================================================
 * Tiny Markdown renderer for assistant replies.
 *
 * Deliberately small and dependency-free (this is an extension; nothing is
 * bundled). Security matters because the text comes from a model: all text is
 * HTML-escaped before any tag is emitted, and link URLs are restricted to
 * http(s)/mailto or relative targets so `javascript:` style URLs cannot get
 * through. Code spans/links are stashed as placeholders before emphasis is
 * applied so their contents are never re-parsed.
 *
 * Supported: fenced code blocks (``` / ~~~), headings (# .. ######),
 * blockquotes, unordered/ordered lists, horizontal rules, GFM tables (with
 * :--- / ---: / :---: alignment), paragraphs, and inline code, bold, italic,
 * strikethrough and links.
 * ===================================================================== */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Returns a safe URL string, or '' to drop the link. */
function sanitizeUrl(url) {
  var u = String(url || '').trim();
  if (!u) return '';
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ''; // block javascript:, data:, ...
  return u; // relative / anchor
}

/* Format a single chunk of text (no block structure). */
function renderInline(text) {
  var stash = [];
  function keep(html) {
    stash.push(html);
    return '\u0000' + (stash.length - 1) + '\u0000';
  }

  // Inline code first, so its contents are never treated as markdown.
  text = String(text == null ? '' : text).replace(/`([^`]+)`/g, function (m, code) {
    return keep('<code>' + escapeHtml(code) + '</code>');
  });

  // Links, with the URL sanitized; unsafe URLs degrade to plain text.
  // The URL part allows one level of balanced parentheses so URLs like
  // https://en.wikipedia.org/wiki/Foo_(bar) survive and javascript:alert(1)
  // is consumed whole rather than leaving a stray ")".
  text = text.replace(/\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g, function (m, label, url) {
    var safe = sanitizeUrl(url);
    if (!safe) return label;
    return keep('<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(label) + '</a>');
  });

  text = escapeHtml(text);

  // Emphasis (the placeholders contain no markdown punctuation).
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return text.replace(/\u0000(\d+)\u0000/g, function (m, i) { return stash[+i]; });
}

/* Split a GFM table row into trimmed cells, dropping the optional leading
 * and trailing pipes. Escaped pipes are not handled (tiny parser). */
function splitTableRow(line) {
  var s = String(line).trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map(function (c) { return c.trim(); });
}

/* True if every cell is a GFM delimiter (---, :--, --:, :-:). */
function isDelimiterRow(cells) {
  if (!cells.length) return false;
  for (var i = 0; i < cells.length; i++) {
    if (!/^:?-+:?$/.test(cells[i])) return false;
  }
  return true;
}

/* Map delimiter cells to a text-align value ('' means default/left). */
function tableAlign(cell) {
  var left = cell.charAt(0) === ':';
  var right = cell.charAt(cell.length - 1) === ':';
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

/* Render a full markdown document to an HTML string. */
function renderMarkdown(src) {
  var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  var out = [];
  var para = [];
  var i = 0;

  function flushPara() {
    if (!para.length) return;
    out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  }

  while (i < lines.length) {
    var line = lines[i];

    // Fenced code block.
    var fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      flushPara();
      var marker = fence[1];
      var lang = fence[2].trim().split(/\s+/)[0];
      var buf = [];
      i++;
      var close = new RegExp('^\\s*' + marker);
      while (i < lines.length && !close.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing fence
      out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') +
        '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // Heading.
    var h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      var level = h[1].length;
      out.push('<h' + level + '>' + renderInline(h[2].trim()) + '</h' + level + '>');
      i++; continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++; continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      var quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderMarkdown(quote.join('\n')) + '</blockquote>');
      continue;
    }

    // GFM table: a row with pipes followed by a delimiter row.
    var delim = i + 1 < lines.length ? splitTableRow(lines[i + 1]) : [];
    if (line.indexOf('|') !== -1 && isDelimiterRow(delim)) {
      var header = splitTableRow(line);
      if (header.length === delim.length) {
        flushPara();
        var align = delim.map(tableAlign);
        function cell(tag, text, idx) {
          return '<' + tag + (align[idx] ? ' style="text-align:' + align[idx] + '"' : '') +
            '>' + renderInline(text) + '</' + tag + '>';
        }
        out.push('<table><thead><tr>');
        for (var c = 0; c < header.length; c++) out.push(cell('th', header[c], c));
        out.push('</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          var cells = splitTableRow(lines[i]);
          out.push('<tr>');
          for (var k = 0; k < header.length; k++) {
            out.push(cell('td', cells[k] === undefined ? '' : cells[k], k));
          }
          out.push('</tr>');
          i++;
        }
        out.push('</tbody></table>');
        continue;
      }
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      out.push('<ul>');
      while (i < lines.length) {
        var uli = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!uli) break;
        out.push('<li>' + renderInline(uli[1]) + '</li>');
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Ordered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      out.push('<ol>');
      while (i < lines.length) {
        var oli = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!oli) break;
        out.push('<li>' + renderInline(oli[1]) + '</li>');
        i++;
      }
      out.push('</ol>');
      continue;
    }

    // Blank line ends the current paragraph.
    if (!line.trim()) { flushPara(); i++; continue; }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}
