/* markdown.js: a small, self-contained Markdown renderer.
 *
 * Security posture: note text is HTML-escaped BEFORE any markup is built, so tags can
 * only ever come from the parser, never from your note. Raw HTML in the source is
 * deliberately NOT passed through. Link schemes are allowlisted. renderInto() then
 * scrubs the result against an element/attribute allowlist, so even a parser bug
 * cannot produce a live event handler or a script tag.
 */
const MD = (() => {
  const NUL = '\u0000';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* Only these schemes may appear in an href. Everything else renders as plain text. */
  function safeUrl(u) {
    const t = String(u).trim();
    if (/^(https?:|mailto:)/i.test(t)) return t;
    return null;                       // relative, javascript:, data:, anything else
  }

  /* ---------------- inline ---------------- */

  function inline(src) {
    let s = esc(src);

    // pull code spans out first so their contents dodge every other rule
    const code = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => NUL + (code.push(c) - 1) + NUL);

    // [text](url)
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text || href}</a>`
        : m;
    });

    // bare http(s) links
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g,
      (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
         .replace(/__([^\n]+?)__/g, '<strong>$1</strong>')
         .replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
         .replace(/(^|[^\w_])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
         .replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

    return s.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), (_, i) => `<code>${code[i]}</code>`);
  }

  /* ---------------- blocks ---------------- */

  const RE_ITEM = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/;
  const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;

  function render(src) {
    // strip control characters, including the sentinel used for code spans
    const lines = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .split('\n');
    return blocks(lines, 0, lines.length);
  }

  function blocks(lines, from, to) {
    const out = [];
    let i = from;

    while (i < to) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // fenced code
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
      if (fence) {
        const close = new RegExp('^ {0,3}\\' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
        const buf = [];
        i++;
        while (i < to && !close.test(lines[i])) buf.push(lines[i++]);
        i++;                                   // consume the closing fence
        const cls = fence[2] ? ` class="lang-${esc(fence[2])}"` : '';
        out.push(`<pre><code${cls}>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

      // blockquote: collected, then rendered recursively
      if (/^ {0,3}>/.test(line)) {
        const buf = [];
        while (i < to && /^ {0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        out.push(`<blockquote>${blocks(buf, 0, buf.length)}</blockquote>`);
        continue;
      }

      // table: a pipe row followed by a |---|---| separator
      if (line.includes('|') && i + 1 < to &&
          /^[\s|:-]*-[\s|:-]*$/.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) =>
          /^:-+:$/.test(c) ? ' class="ta-c"' : /-+:$/.test(c) ? ' class="ta-r"' : '');
        i += 2;
        const body = [];
        while (i < to && lines[i].includes('|') && lines[i].trim()) body.push(cells(lines[i++]));
        out.push('<table><thead><tr>' +
          head.map((c, k) => `<th${align[k] || ''}>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c, k) => `<td${align[k] || ''}>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>');
        continue;
      }

      if (RE_ITEM.test(line)) { i = list(lines, i, to, out); continue; }

      // paragraph
      const buf = [];
      while (i < to && lines[i].trim() && !RE_ITEM.test(lines[i]) && !RE_HR.test(lines[i]) &&
             !/^ {0,3}(#{1,6}\s|>|`{3,}|~{3,})/.test(lines[i])) buf.push(lines[i++]);
      if (buf.length) out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }

    return out.join('');
  }

  /* Lists, with real nesting: deeper-indented lines recurse through blocks(). */
  function list(lines, i, to, out) {
    const first = lines[i].match(RE_ITEM);
    const base = indentOf(lines[i]);
    const ordered = first[2] !== undefined;
    const items = [];

    while (i < to) {
      const m = lines[i] && lines[i].match(RE_ITEM);
      if (!m || indentOf(lines[i]) !== base) break;
      if ((m[2] !== undefined) !== ordered) break;     // list type changed

      const buf = [m[3]];
      i++;
      while (i < to && lines[i].trim() && indentOf(lines[i]) > base) {
        buf.push(lines[i].slice(Math.min(indentOf(lines[i]), base + 2)));
        i++;
      }

      // task list marker
      let task = '';
      const t = buf[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (t) {
        task = t[1] === ' ' ? '<span class="task">&#9744;</span> ' : '<span class="task done">&#9745;</span> ';
        buf[0] = t[2];
      }

      const inner = blocks(buf, 0, buf.length);
      // Unwrap the item's own leading paragraph so lists stay tight, including when
      // the item also carries a nested block: <p>a</p><ul>..  ->  a<ul>..
      const body = inner.startsWith('<p>') ? inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1') : inner;
      items.push(`<li${task ? ' class="task-item"' : ''}>${task}${body}</li>`);
    }

    const tag = ordered ? 'ol' : 'ul';
    const start = ordered && first[2] !== '1' ? ` start="${parseInt(first[2], 10)}"` : '';
    out.push(`<${tag}${start}>${items.join('')}</${tag}>`);
    return i;
  }

  /* ---------------- DOM sanitizer (defence in depth) ---------------- */

  const TAGS = new Set(['P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'DEL',
    'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN']);
  const ATTR = { A: ['href', 'target', 'rel'], OL: ['start'], DEFAULT: ['class'] };

  function scrub(root) {
    for (const el of [...root.querySelectorAll('*')]) {
      if (!TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      const allowed = new Set([...(ATTR[el.tagName] || []), ...ATTR.DEFAULT]);
      for (const a of [...el.attributes]) {
        if (!allowed.has(a.name)) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A' && !safeUrl(el.getAttribute('href') || '')) el.removeAttribute('href');
    }
    return root;
  }

  /* Strip markdown syntax down to readable text: for the note-list preview line. */
  function plain(src) {
    return String(src == null ? '' : src)
      .replace(/```[\s\S]*?```/g, ' ')                 // fenced code
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')               // heading marks
      .replace(/^\s{0,3}>\s?/gm, '')                    // quote marks
      .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ' ')  // rules
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+/gm, (_, c) =>
        (c === ' ' ? '\u2610 ' : '\u2611 '))            // task boxes survive as glyphs
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')        // bullets
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links -> their text
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
      .replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_([^_\n]+?)_(?!\w)/g, '$1$2')
      .replace(/^[\s|:-]*-[\s|:-]*$/gm, ' ')            // table separator rows
      .replace(/\s*\|\s*/g, '  ')                      // table cells
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderInto(el, src) {
    el.innerHTML = render(src);
    scrub(el);
    return el;
  }

  return { render, renderInto, scrub, safeUrl, plain };
})();
