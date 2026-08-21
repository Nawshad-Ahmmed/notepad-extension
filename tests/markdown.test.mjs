import { readFileSync } from 'fs';
import vm from 'vm';

const ctx = vm.createContext({ console, RegExp, String, Math, Set, parseInt });
vm.runInContext(readFileSync('markdown.js', 'utf8') + '\nglobalThis.MD = MD;', ctx);
const { render, safeUrl, plain } = ctx.MD;

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond && got !== undefined) console.log(`      got: ${got}`);
};
const eq = (name, src, want) => { const g = render(src); ok(name, g === want, g); };

console.log('--- injection ---');
// Note text must never become live markup.
const vectors = [
  ['script tag', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['iframe', '<iframe src="javascript:alert(1)">'],
  ['closing-tag breakout', 'hi</p><script>alert(1)</script><p>'],
  ['in a heading', '# <script>alert(1)</script>'],
  ['in a code span', '`<script>alert(1)</script>`'],
  ['in a fence', '```\n<script>alert(1)</script>\n```'],
  ['in a table cell', 'a | b\n---|---\n<script>x</script> | 2'],
  ['in a list item', '- <script>alert(1)</script>'],
  ['in a blockquote', '> <script>alert(1)</script>'],
  ['in link text', '[<script>alert(1)</script>](https://ok.com)'],
];
const ALLOWED = new Set(['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del',
  'code','pre','blockquote','ul','ol','li','a','table','thead','tbody','tr','th','td','span']);
// A vector is defeated when the output contains no tag outside the allowlist and no
// event-handler attribute inside a real tag. Escaped text such as &lt;img onerror=..&gt;
// is inert and must NOT count as a failure.
function liveMarkupIn(html) {
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  const rogue = tags.filter((t) => !ALLOWED.has(t));
  const handlers = [...html.matchAll(/<[^>]*?\son[a-z]+\s*=/gi)].map((m) => m[0]);
  return [...rogue, ...handlers];
}
for (const [name, src] of vectors) {
  const out = render(src);
  const live = liveMarkupIn(out);
  ok(`no live markup: ${name}`, live.length === 0, live.length ? live.join(', ') + '  in  ' + out : undefined);
}

console.log('\n--- link scheme allowlist ---');
const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x',
  'vbscript:msgbox', 'file:///etc/passwd', 'chrome-extension://abc/x.html', '/relative', '#anchor'];
for (const u of bad) ok(`rejected: ${u}`, safeUrl(u) === null, safeUrl(u));
for (const u of ['https://example.com/a?b=1', 'http://x.test', 'mailto:a@b.c']) {
  ok(`allowed: ${u}`, safeUrl(u) === u);
}
ok('javascript: link renders as plain text, no href',
  !render('[click](javascript:alert(1))').includes('<a '), render('[click](javascript:alert(1))'));
ok('quote in URL cannot break out of href',
  !/href="[^"]*"[a-z]/i.test(render('[x](https://a.com/"onmouseover="alert(1))')),
  render('[x](https://a.com/"onmouseover="alert(1))'));

console.log('\n--- formatting ---');
eq('heading', '## Title', '<h2>Title</h2>');
eq('bold', '**bold**', '<p><strong>bold</strong></p>');
eq('italic', '*it*', '<p><em>it</em></p>');
eq('strikethrough', '~~gone~~', '<p><del>gone</del></p>');
eq('code span', 'run `ls -la` now', '<p>run <code>ls -la</code> now</p>');
eq('underscores inside a word are left alone', 'snake_case_name', '<p>snake_case_name</p>');
eq('markdown inside a code span is inert', '`**not bold**`', '<p><code>**not bold**</code></p>');
eq('hr', '---', '<hr>');
eq('unordered list', '- a\n- b', '<ul><li>a</li><li>b</li></ul>');
eq('ordered list', '1. a\n2. b', '<ol><li>a</li><li>b</li></ol>');
eq('ordered list keeps its start', '3. a', '<ol start="3"><li>a</li></ol>');
eq('nested list', '- a\n  - b', '<ul><li>a<ul><li>b</li></ul></li></ul>');
eq('blockquote', '> quoted', '<blockquote><p>quoted</p></blockquote>');
eq('fenced code keeps the language', '```js\nlet x = 1 < 2;\n```',
   '<pre><code class="lang-js">let x = 1 &lt; 2;</code></pre>');
eq('line break inside a paragraph', 'one\ntwo', '<p>one<br>two</p>');
eq('link', '[site](https://a.test)',
   '<p><a href="https://a.test" target="_blank" rel="noopener noreferrer">site</a></p>');
eq('bare url autolinks', 'see https://a.test now',
   '<p>see <a href="https://a.test" target="_blank" rel="noopener noreferrer">https://a.test</a> now</p>');

ok('task list renders checkboxes', render('- [ ] todo\n- [x] done')
  .includes('&#9744;') && render('- [ ] todo\n- [x] done').includes('&#9745;'));
ok('table renders header and body',
  render('a | b\n---|---\n1 | 2') === '<table><thead><tr><th>a</th><th>b</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  render('a | b\n---|---\n1 | 2'));
ok('table alignment becomes a class, never inline style',
  render('a|b\n:-:|--:\n1|2').includes('class="ta-c"') && !render('a|b\n:-:|--:\n1|2').includes('style'));

console.log('\n--- plain-text preview (note list) ---');
const peq = (name, src, want) => { const g = plain(src); ok(name, g === want, g); };
peq('strips heading and renders task boxes', '## v1.2 — ship\n\n- [x] Enc\n- [ ] Shots',
    'v1.2 — ship \u2611 Enc \u2610 Shots');
peq('unwraps code spans', 'Use `zip -r x.zip .` here', 'Use zip -r x.zip . here');
peq('drops emphasis marks', '**bold** and *it* and ~~gone~~', 'bold and it and gone');
peq('keeps link text, drops the url', 'See [the docs](https://a.test) now', 'See the docs now');
peq('drops quote marks', '> quoted line', 'quoted line');
peq('flattens a table', '| a | b |\n|---|---|\n| 1 | 2 |', 'a b 1 2');
peq('drops fenced code entirely', '```js\nsecret()\n```\nafter', 'after');
peq('drops list numbering', '1. one\n2. two', 'one two');
peq('handles empty input', '', '');
// plain() returns PLAIN TEXT by contract — escaping belongs to whoever renders it.
// The note list escapes it via highlight(); tests/app.test.mjs asserts that end.
peq('leaves html as literal text for the caller to escape', '<b>x</b> **y**', '<b>x</b> y');

console.log('\n--- robustness ---');
for (const [name, src] of [
  ['empty string', ''], ['null', null], ['undefined', undefined],
  ['unclosed fence', '```js\nlet x=1'],
  ['unclosed bold', '**never closed'],
  ['lone pipe', '|'],
  ['deep nesting', '- a\n'.repeat(50) + '      - deep'],
  ['long line', 'x'.repeat(50000)],
]) {
  let threw = null;
  try { render(src); } catch (e) { threw = e.message; }
  ok(`survives ${name}`, threw === null, threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
