/* Notepad — popup + side panel share this script. */

const KEY = 'notepad';
const $ = (id) => document.getElementById(id);

let state = { notes: [], theme: 'auto', preview: false };
let vaultMeta = null;   // { salt, iter } once encryption is on
let vaultKey = null;    // CryptoKey while unlocked; null while locked
let activeId = null;
let query = '';
let selfWrite = false;
let saveTimer = null;

/* ---------------- storage ---------------- */

async function load() {
  const got = await chrome.storage.local.get(KEY);
  const s = got[KEY] || {};
  state.theme = s.theme || 'auto';
  state.preview = !!s.preview;

  if (s.enc) {
    vaultMeta = { salt: s.enc.salt, iter: s.enc.iter };
    const key = await Vault.cached();
    if (!key) return 'locked';
    try {
      state.notes = await Vault.decrypt(key, s.enc);
      vaultKey = key;
      return 'unlocked';
    } catch {
      await Vault.forget();          // cached key no longer matches this vault
      return 'locked';
    }
  }

  state.notes = Array.isArray(s.notes) ? s.notes : [];
  return 'plain';
}

function persist(immediate = false) {
  clearTimeout(saveTimer);

  // Hard guard: never write while the vault is locked — state.notes is empty
  // then, and a write would overwrite the ciphertext with nothing.
  if (vaultMeta && !vaultKey) return Promise.resolve();

  const write = async () => {
    let payload;
    if (vaultKey) {
      const blob = await Vault.encrypt(vaultKey, state.notes);
      payload = { v: 2, theme: state.theme, preview: state.preview, enc: { ...vaultMeta, ...blob } };
      Vault.touch();
    } else {
      payload = { v: 1, theme: state.theme, preview: state.preview, notes: state.notes };
    }
    selfWrite = true;
    await chrome.storage.local.set({ [KEY]: payload });
    flashSaved();
  };

  if (immediate) return write();
  saveTimer = setTimeout(write, 350);
  return Promise.resolve();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  if (selfWrite) { selfWrite = false; return; }

  const s = changes[KEY].newValue || {};
  state.theme = s.theme || 'auto';
  state.preview = !!s.preview;
  applyTheme();

  if (s.enc) {
    vaultMeta = { salt: s.enc.salt, iter: s.enc.iter };
    if (!vaultKey) return;                       // still locked here
    try {
      state.notes = await Vault.decrypt(vaultKey, s.enc);
    } catch {
      return lockNow(false);                     // stale copy — do not write it back
    }
  } else {
    vaultMeta = null;
    vaultKey = null;
    state.notes = Array.isArray(s.notes) ? s.notes : [];
  }

  updateVaultUI();
  renderList();
  const n = note(activeId);
  if (!n) { if (activeId) showList(); return; }
  if (document.activeElement !== $('note-body') && document.activeElement !== $('note-title')) {
    $('note-title').value = n.title;
    $('note-body').value = n.body;
    renderStats();
  }
});

/* ---------------- helpers ---------------- */

const note = (id) => state.notes.find((n) => n.id === id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function when(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function highlight(text, q) {
  const out = esc(text);
  if (!q) return out;
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return out.replace(rx, (m) => `<mark>${m}</mark>`);
}

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function slug(s) {
  return (s.trim() || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note';
}

let flashTimer = null;
function toast(msg) {
  const el = $('status');
  el.textContent = msg;
  el.classList.remove('hide');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.add('hide'), 1200);
}
const flashSaved = () => toast('Saved');

/* ---------------- theme ---------------- */

function applyTheme() {
  const dark = state.theme === 'dark' ||
    (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/* ---------------- list ---------------- */

function sorted() {
  return [...state.notes].sort((a, b) =>
    (b.pinned === true) - (a.pinned === true) || b.updated - a.updated);
}

function renderList() {
  const q = query.trim().toLowerCase();
  const items = sorted().filter((n) =>
    !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
  const list = $('list');

  if (!items.length) {
    list.innerHTML = `<div class="empty">
      <svg class="icon" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>
      <div>${state.notes.length ? 'No notes match that search.' : 'No notes yet — hit <b>New</b> to start.'}</div>
    </div>`;
    return;
  }

  list.innerHTML = items.map((n) => {
    const preview = MD.plain(n.body);
    return `<div class="note" data-id="${esc(String(n.id))}">
      <div class="body">
        <div class="t">${n.pinned ? '<span class="pin">•</span>' : ''}${highlight(n.title || 'Untitled', q)}</div>
        <div class="p">${preview ? highlight(preview.slice(0, 120), q) : '<i>Empty</i>'}</div>
        <div class="d">${when(n.updated)}</div>
      </div>
      <div class="acts">
        <button data-act="pin" title="${n.pinned ? 'Unpin' : 'Pin'}">
          <svg class="icon" viewBox="0 0 24 24" ${n.pinned ? 'fill="currentColor"' : ''}><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6z"/><path d="M12 14v7"/></svg>
        </button>
        <button data-act="del" class="danger" title="Delete">
          <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

/* ---------------- screens ---------------- */

function show(which) {
  for (const id of ['screen-lock', 'screen-list', 'screen-edit']) {
    $(id).classList.toggle('active', id === which);
  }
}

function showList() {
  activeId = null;
  show('screen-list');
  renderList();
}

function showLock() {
  activeId = null;
  $('unlock-pass').value = '';
  $('unlock-err').textContent = '';
  show('screen-lock');
  setTimeout(() => $('unlock-pass').focus(), 30);
}

function openNote(id) {
  const n = note(id);
  if (!n) return;
  activeId = id;
  show('screen-edit');
  $('note-title').value = n.title;
  $('note-body').value = n.body;
  updatePinButton();
  renderStats();
  applyPreview();
  if (state.preview) $('note-title').focus();
  else ($('note-title').value ? $('note-body') : $('note-title')).focus();
}

function applyPreview() {
  const on = state.preview;
  $('note-body').hidden = on;
  $('note-preview').hidden = !on;
  $('btn-preview').style.color = on ? 'var(--accent)' : '';
  $('btn-preview').title = on ? 'Back to editing (Ctrl+E)' : 'Preview markdown (Ctrl+E)';
  if (on) MD.renderInto($('note-preview'), $('note-body').value);
}

function togglePreview() {
  if (!activeId) return;
  state.preview = !state.preview;
  applyPreview();
  if (!state.preview) $('note-body').focus();
  persist(true);
}

function updatePinButton() {
  const n = note(activeId);
  $('btn-pin').style.color = n && n.pinned ? 'var(--accent)' : '';
  $('btn-pin').title = n && n.pinned ? 'Unpin note' : 'Pin note';
}

function renderStats() {
  const t = $('note-body').value;
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  const n = note(activeId);
  $('stats').textContent =
    `${words} word${words === 1 ? '' : 's'} · ${t.length} chars` +
    (n ? ` · edited ${when(n.updated)}` : '');
}

function updateVaultUI() {
  const on = !!vaultMeta;
  $('btn-encrypt-label').textContent = on ? 'Encryption is on' : 'Encrypt notes…';
  $('btn-encrypt').disabled = on;
  $('btn-encrypt').style.opacity = on ? 0.55 : '';
  $('btn-lock').hidden = !on;
  $('btn-passphrase').hidden = !on;
  $('btn-decrypt').hidden = !on;
  $('lockbadge').hidden = !on;
}

/* ---------------- passphrase dialog ---------------- */

let dlgValidate = null;

function askPass({ title, hint, ok, old = false, confirm: needConfirm = true, validate }) {
  const dlg = $('dlg');
  $('dlg-title').textContent = title;
  $('dlg-hint').textContent = hint || '';
  $('dlg-ok').textContent = ok;
  $('dlg-old').hidden = !old;
  $('dlg-p1').hidden = false;
  $('dlg-p2').hidden = !needConfirm;
  $('dlg-p1').placeholder = needConfirm ? 'New passphrase' : 'Passphrase';
  $('dlg-old').value = $('dlg-p1').value = $('dlg-p2').value = '';
  $('dlg-err').textContent = '';
  dlgValidate = validate;
  dlg.showModal();
  setTimeout(() => (old ? $('dlg-old') : $('dlg-p1')).focus(), 30);

  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'
      ? { old: dlg._old, pass: dlg._pass }
      : null), { once: true });
  });
}

$('dlg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dlg = $('dlg');
  const oldPass = $('dlg-old').value;
  const p1 = $('dlg-p1').value;
  const p2 = $('dlg-p2').value;
  const err = $('dlg-err');

  if (p1.length < 8) return (err.textContent = 'Use at least 8 characters.');
  if (!$('dlg-p2').hidden && p1 !== p2) return (err.textContent = 'The two passphrases do not match.');

  if (dlgValidate) {
    err.textContent = 'Checking…';
    const problem = await dlgValidate({ old: oldPass, pass: p1 });
    if (problem) return (err.textContent = problem);
  }

  dlg._old = oldPass;
  dlg._pass = p1;
  dlg.returnValue = 'ok';
  dlg.close();
});

$('dlg-cancel').addEventListener('click', () => {
  const dlg = $('dlg');
  dlg.returnValue = 'cancel';
  dlg.close();
});

/* ---------------- vault flows ---------------- */

async function storedBlob() {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] || {}).enc || null;
}

// Re-derive from the stored salt and try the ciphertext: the GCM tag is the check.
async function checkPass(pass) {
  const blob = await storedBlob();
  if (!blob) return null;
  try {
    const key = await Vault.unlock(pass, blob);
    await Vault.decrypt(key, blob);
    return key;
  } catch {
    return null;
  }
}

async function enableEncryption() {
  const r = await askPass({
    title: 'Encrypt your notes',
    hint: 'Your notes get encrypted with AES-GCM using a key derived from this passphrase. '
        + 'It is never stored anywhere — if you lose it, the notes are gone for good.',
    ok: 'Encrypt',
  });
  if (!r) return;
  const { key, meta } = await Vault.create(r.pass);
  vaultKey = key;
  vaultMeta = meta;
  await Vault.cache(key);
  await persist(true);
  updateVaultUI();
  toast('Encrypted');
}

async function changePassphrase() {
  const r = await askPass({
    title: 'Change passphrase',
    hint: 'Notes are re-encrypted under a new key derived from the new passphrase.',
    ok: 'Change',
    old: true,
    validate: async ({ old }) => (await checkPass(old)) ? null : 'That current passphrase is wrong.',
  });
  if (!r) return;
  const { key, meta } = await Vault.create(r.pass);
  vaultKey = key;
  vaultMeta = meta;
  await Vault.cache(key);
  await persist(true);
  toast('Passphrase changed');
}

async function disableEncryption() {
  const r = await askPass({
    title: 'Turn off encryption',
    hint: 'Your notes will be written back to disk in plain text, readable by anyone '
        + 'with access to this computer.',
    ok: 'Turn off',
    confirm: false,
    validate: async ({ pass }) => (await checkPass(pass)) ? null : 'That passphrase is wrong.',
  });
  if (!r) return;
  vaultKey = null;
  vaultMeta = null;
  await Vault.forget();
  await persist(true);
  updateVaultUI();
  toast('Encryption off');
}

async function lockNow(flush = true) {
  if (flush && vaultKey && saveTimer) await persist(true);   // don't lose in-flight edits
  clearTimeout(saveTimer);
  await Vault.forget();
  vaultKey = null;
  state.notes = [];
  query = '';
  $('search').value = '';
  showLock();
}

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('unlock-pass').value;
  const err = $('unlock-err');
  const btn = $('btn-unlock');
  if (!pass) return;
  btn.disabled = true;
  err.textContent = 'Decrypting…';

  const key = await checkPass(pass);
  if (!key) {
    btn.disabled = false;
    $('unlock-pass').value = '';
    err.textContent = 'Wrong passphrase.';
    return;
  }

  const blob = await storedBlob();
  state.notes = await Vault.decrypt(key, blob);
  vaultKey = key;
  await Vault.cache(key);
  btn.disabled = false;
  err.textContent = '';
  $('unlock-pass').value = '';
  updateVaultUI();
  showList();
  const last = sorted()[0];
  if (last) openNote(last.id);
});

/* ---------------- actions ---------------- */

function newNote() {
  if (vaultMeta && !vaultKey) return;
  const n = { id: uid(), title: '', body: '', created: Date.now(), updated: Date.now(), pinned: false };
  state.notes.push(n);
  persist(true);
  openNote(n.id);
}

function editNote() {
  const n = note(activeId);
  if (!n) return;
  n.title = $('note-title').value;
  n.body = $('note-body').value;
  n.updated = Date.now();
  renderStats();
  if (state.preview) MD.renderInto($('note-preview'), n.body);
  persist();
}

function deleteNote(id) {
  const n = note(id);
  if (!n) return;
  const label = n.title || (n.body.trim().slice(0, 30) || 'this empty note');
  if ((n.title || n.body.trim()) && !confirm(`Delete "${label}"?`)) return;
  state.notes = state.notes.filter((x) => x.id !== id);
  persist(true);
  if (activeId === id) showList(); else renderList();
}

/* ---------------- wiring ---------------- */

$('btn-new').addEventListener('click', newNote);
$('btn-back').addEventListener('click', () => { persist(true); showList(); });

$('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });

$('list').addEventListener('click', (e) => {
  const row = e.target.closest('.note');
  if (!row) return;
  const id = row.dataset.id;
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'del') return deleteNote(id);
  if (act === 'pin') {
    const n = note(id);
    n.pinned = !n.pinned;
    persist(true);
    return renderList();
  }
  openNote(id);
});

$('note-title').addEventListener('input', editNote);
$('note-body').addEventListener('input', editNote);

$('note-body').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey) return;
  e.preventDefault();
  const el = e.target, s = el.selectionStart, t = el.selectionEnd;
  el.value = el.value.slice(0, s) + '\t' + el.value.slice(t);
  el.selectionStart = el.selectionEnd = s + 1;
  editNote();
});

$('btn-pin').addEventListener('click', () => {
  const n = note(activeId);
  if (!n) return;
  n.pinned = !n.pinned;
  updatePinButton();
  persist(true);
});

$('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('note-body').value);
  toast('Copied');
});

$('btn-download').addEventListener('click', () => {
  if (vaultMeta && !confirm('This writes the note to disk as plain text. Continue?')) return;
  const title = $('note-title').value;
  download(`${slug(title)}.txt`, (title ? title + '\n\n' : '') + $('note-body').value);
});

$('btn-delete').addEventListener('click', () => deleteNote(activeId));
$('btn-preview').addEventListener('click', togglePreview);

$('btn-theme').addEventListener('click', () => {
  state.theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
  applyTheme();
  if (vaultMeta && !vaultKey) {
    chrome.storage.local.get(KEY).then((got) => {           // theme is not secret
      selfWrite = true;
      chrome.storage.local.set({ [KEY]: { ...got[KEY], theme: state.theme } });
    });
  } else {
    persist(true);
  }
});

/* menu */
$('btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  $('menu').classList.toggle('open');
});
document.addEventListener('click', () => $('menu').classList.remove('open'));

$('btn-encrypt').addEventListener('click', enableEncryption);
$('btn-passphrase').addEventListener('click', changePassphrase);
$('btn-decrypt').addEventListener('click', disableEncryption);
$('btn-lock').addEventListener('click', lockNow);

$('btn-export-all').addEventListener('click', () => {
  if (vaultMeta && !confirm('The export file is plain text — anyone who gets it can read every note. Continue?')) return;
  const stamp = new Date().toISOString().slice(0, 10);
  download(`notepad-backup-${stamp}.json`,
    JSON.stringify({ exported: Date.now(), notes: state.notes }, null, 2), 'application/json');
});

$('btn-import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : data.notes;
    if (!Array.isArray(incoming)) throw new Error('no notes array');
    const have = new Set(state.notes.map((n) => n.id));
    let added = 0;
    for (const n of incoming) {
      if (typeof n?.body !== 'string' && typeof n?.title !== 'string') continue;
      // Imported ids are attacker-controlled input: mint our own rather than
      // trusting a string that ends up in the DOM and in lookups.
      let id = uid();
      while (have.has(id)) id = uid();
      have.add(id);
      state.notes.push({
        id,
        title: String(n.title ?? ''),
        body: String(n.body ?? ''),
        created: Number(n.created) || Date.now(),
        updated: Number(n.updated) || Date.now(),
        pinned: !!n.pinned,
      });
      added++;
    }
    await persist(true);
    renderList();
    alert(`Imported ${added} note${added === 1 ? '' : 's'}.`);
  } catch (err) {
    alert(`Could not import that file: ${err.message}`);
  }
  e.target.value = '';
});

const panelBtn = $('btn-panel');
if (panelBtn) {
  // cached up-front: sidePanel.open() must run inside the click's user gesture,
  // so we cannot await anything before calling it.
  let winId = null;
  chrome.windows.getCurrent().then((w) => { winId = w.id; });
  panelBtn.addEventListener('click', () => {
    if (winId == null) return;
    chrome.sidePanel.open({ windowId: winId });
    window.close();
  });
}

/* shortcuts */
document.addEventListener('keydown', (e) => {
  if ($('dlg').open) return;
  const mod = e.ctrlKey || e.metaKey;
  const locked = $('screen-lock').classList.contains('active');
  if (mod && e.key.toLowerCase() === 'l' && vaultKey) { e.preventDefault(); return lockNow(); }
  if (locked) return;
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); togglePreview(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); persist(true); }
  else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  else if (mod && e.key.toLowerCase() === 'f' && $('screen-list').classList.contains('active')) {
    e.preventDefault(); $('search').focus();
  }
  else if (e.key === 'Escape') {
    if ($('menu').classList.contains('open')) return $('menu').classList.remove('open');
    if ($('screen-edit').classList.contains('active')) { persist(true); showList(); }
  }
});

window.addEventListener('beforeunload', () => { if (saveTimer) persist(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) persist(true);
});

/* idle auto-lock: push the deadline out on real activity, poll for expiry */
for (const ev of ['keydown', 'pointerdown']) {
  document.addEventListener(ev, () => { if (vaultKey) Vault.touch(); }, true);
}
setInterval(async () => {
  if (!vaultKey) return;
  if (!(await Vault.cached())) lockNow();
}, 20000);

/* ---------------- boot ---------------- */

(async () => {
  const mode = await load();
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  updateVaultUI();

  if (mode === 'locked') return showLock();

  showList();
  const last = sorted()[0];
  if (last) openNote(last.id);
})();
