import { readFileSync } from 'fs';
import vm from 'vm';

const local = {}, session = {};
const listeners = [];
const mkEl = () => new Proxy({
  classList: { toggle(){}, add(){}, remove(){}, contains: () => false },
  style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', placeholder: '',
  hidden: false, disabled: false, open: false, files: [],
  addEventListener(){}, removeEventListener(){}, focus(){}, click(){},
  querySelectorAll: () => [],
  showModal(){}, close(){}, closest: () => null, appendChild(){},
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => (t[k] = v, true) });

const els = {};
const ctx = vm.createContext({
  crypto, btoa, atob, TextEncoder, TextDecoder, console, Date, Math, JSON, RegExp, String, Set, parseInt,
  setTimeout, clearTimeout, setInterval, URL, Blob, alert(){}, confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener(){} }),
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    getElementById: (id) => (els[id] ||= mkEl()),
    addEventListener(){}, createElement: () => mkEl(),
    activeElement: null, visibilityState: 'visible',
    documentElement: { classList: { toggle(){}, add(){}, remove(){}, contains: () => false } },
  },
  window: { addEventListener(){}, close(){} },
  chrome: {
    storage: {
      local: {
        get: async (k) => (k in local ? { [k]: local[k] } : {}),
        set: async (o) => Object.assign(local, o),
      },
      session: {
        get: async (k) => (k in session ? { [k]: session[k] } : {}),
        set: async (o) => Object.assign(session, o),
        remove: async (k) => { delete session[k]; },
      },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    sidePanel: { open(){} },
  },
});

const src = readFileSync('vault.js', 'utf8') + '\n' + readFileSync('markdown.js', 'utf8') +
  '\n' + readFileSync('app.js', 'utf8') +
  '\nglobalThis.__t = { load, persist, state, newNote, V: Vault, renderList, showList, ' +
  'checkPass, storedBlob, get vaultKey(){return vaultKey}, get vaultMeta(){return vaultMeta}, ' +
  'setKey(k,m){vaultKey=k;vaultMeta=m}, clearKey(){vaultKey=null}, lockNow };';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

try { vm.runInContext(src, ctx); ok('app.js loads with no top-level error', true); }
catch (e) { ok(`app.js loads (${e.message})`, false); process.exit(1); }

await new Promise(r => setTimeout(r, 50));   // let boot() finish
const T = ctx.__t;

// --- plaintext mode ---
T.state.notes.push({ id: 'n1', title: 'Grocery', body: 'milk', created: 1, updated: 1, pinned: false });
await T.persist(true);
ok('plaintext mode writes readable notes', JSON.stringify(local.notepad).includes('milk'));

// --- enable encryption ---
const { key, meta } = await T.V.create('a strong passphrase');
T.setKey(key, meta);
await T.persist(true);
const raw = JSON.stringify(local.notepad);
ok('after encrypting, no plaintext on disk', !raw.includes('milk') && !raw.includes('Grocery'));
ok('stored record has salt + iter + iv + ct', ['salt','iter','iv','ct'].every(k => k in local.notepad.enc));
ok('passphrase itself is never stored', !raw.includes('a strong passphrase'));

// --- LOCKED: reload with no cached key ---
delete session.vaultkey;
T.clearKey();
T.state.notes = [];
const mode = await T.load();
ok('reload with no cached key reports locked', mode === 'locked');
ok('locked reload exposes no notes in memory', T.state.notes.length === 0);

// --- the data-loss guard: a write while locked must be refused ---
const before = JSON.stringify(local.notepad);
await T.persist(true);
ok('write while locked is refused (ciphertext intact)', JSON.stringify(local.notepad) === before);

// --- wrong passphrase ---
ok('wrong passphrase does not unlock', (await T.checkPass('a strong passphrasE')) === null);

// --- correct passphrase recovers the notes ---
const k2 = await T.checkPass('a strong passphrase');
ok('correct passphrase verifies', !!k2);
const recovered = await T.V.decrypt(k2, await T.storedBlob());
ok('notes survive the encrypt/lock/unlock round trip',
   recovered.length === 1 && recovered[0].body === 'milk' && recovered[0].title === 'Grocery');

// --- theme stays readable while locked (needed to paint the lock screen) ---
ok('theme is stored outside the ciphertext', 'theme' in local.notepad);
ok('preview mode is stored outside the ciphertext', 'preview' in local.notepad);
ok('the note text itself is never outside the ciphertext',
   !JSON.stringify(local.notepad).includes('milk'));

// --- the note list must escape note text, even after MD.plain() strips markdown ---
T.state.notes.push({ id: 'x1', title: '<img src=x onerror=alert(1)>',
  body: '<script>alert(1)</script> **bold**', created: 1, updated: 1, pinned: false });
T.renderList();
const listHtml = els.list.innerHTML;
const tags = [...listHtml.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
const ALLOWED = new Set(['div','span','button','svg','path','circle','b','i','mark','br']);
ok('note list renders no tag outside its own markup',
   tags.every((t) => ALLOWED.has(t)), tags.filter((t) => !ALLOWED.has(t)).join(','));
ok('note list emits no event handler',
   !/<[^>]*\son[a-z]+\s*=/i.test(listHtml));
ok('hostile note text survives as escaped text',
   listHtml.includes('&lt;img') || listHtml.includes('&lt;script'), listHtml.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
