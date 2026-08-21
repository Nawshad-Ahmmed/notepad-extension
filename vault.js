/* vault.js: encryption at rest for Notepad.
 *
 * Passphrase --PBKDF2-SHA256(600k)--> AES-GCM-256 key --> encrypts the whole
 * notes array as one blob. The passphrase is never stored. The derived key is
 * held only in chrome.storage.session (memory; wiped when Chrome exits) with an
 * idle timeout, so you unlock once per browser session rather than per popup.
 */
const Vault = (() => {
  const ITER = 1200000;                // 2x the OWASP floor for PBKDF2-HMAC-SHA256;
                                       // unlock happens once per browser session, so the
                                       // extra ~0.3s is invisible but doubles attacker cost
  const TTL = 15 * 60 * 1000;          // idle auto-lock
  const SKEY = 'vaultkey';
  const te = new TextEncoder();
  const td = new TextDecoder();

  /* base64 helpers: chunked, so a large note can't blow the call stack */
  function b64(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return btoa(s);
  }
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function derive(passphrase, salt, iter = ITER) {
    const base = await crypto.subtle.importKey(
      'raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      true,                            // extractable: required to cache in session storage
      ['encrypt', 'decrypt']);
  }

  /* Build a fresh vault descriptor for a new passphrase. */
  async function create(passphrase) {
    const salt = rand(16);
    const key = await derive(passphrase, salt);
    return { key, meta: { salt: b64(salt), iter: ITER } };
  }

  /* Re-derive from an existing vault's parameters. */
  async function unlock(passphrase, meta) {
    return derive(passphrase, unb64(meta.salt), meta.iter || ITER);
  }

  async function encrypt(key, data) {
    const iv = rand(12);               // fresh IV every write: never reused
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(data)));
    return { iv: b64(iv), ct: b64(ct) };
  }

  /* Throws on a wrong key: the GCM auth tag is the passphrase check. */
  async function decrypt(key, blob) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return JSON.parse(td.decode(pt));
  }

  /* ---- in-memory key cache (chrome.storage.session never touches disk) ---- */

  async function cache(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    await chrome.storage.session.set({ [SKEY]: { k: b64(raw), until: Date.now() + TTL } });
  }

  async function cached() {
    const got = await chrome.storage.session.get(SKEY);
    const c = got[SKEY];
    if (!c) return null;
    if (Date.now() > c.until) { await forget(); return null; }
    return crypto.subtle.importKey(
      'raw', unb64(c.k), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  /* Push the idle deadline out; called on user activity. */
  async function touch() {
    const got = await chrome.storage.session.get(SKEY);
    const c = got[SKEY];
    if (c) await chrome.storage.session.set({ [SKEY]: { ...c, until: Date.now() + TTL } });
  }

  const forget = () => chrome.storage.session.remove(SKEY);

  return { create, unlock, encrypt, decrypt, cache, cached, touch, forget, TTL, ITER };
})();
