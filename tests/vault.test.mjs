import { readFileSync } from 'fs';
import vm from 'vm';

// stub the only chrome API vault.js touches
const session = {};
const ctx = vm.createContext({
  crypto, btoa, atob, TextEncoder, TextDecoder, console, Date,
  chrome: { storage: { session: {
    set: async (o) => Object.assign(session, o),
    get: async (k) => (k in session ? { [k]: session[k] } : {}),
    remove: async (k) => { delete session[k]; },
  } } },
});
vm.runInContext(readFileSync('vault.js', 'utf8') + '\nglobalThis.V = Vault;', ctx);
const V = ctx.V;

const notes = [{ id: 'a1', title: 'DHL creds', body: 'token: abc123\n'.repeat(2000), pinned: true }];
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

// 1. round trip
const t0 = Date.now();
const { key, meta } = await V.create('correct horse battery staple');
const kdfMs = Date.now() - t0;
const blob = await V.encrypt(key, notes);
const back = await V.decrypt(key, blob);
ok('round-trip preserves notes exactly', JSON.stringify(back) === JSON.stringify(notes));
const tFast = Date.now(); await V.unlock('x', { salt: meta.salt, iter: 1000 }); const fastMs = Date.now() - tFast;
ok(`KDF work scales with iterations (${V.ITER} iters: ${kdfMs}ms vs 1k iters: ${fastMs}ms)`, kdfMs > fastMs * 20);

// 2. ciphertext is not the plaintext
ok('ciphertext leaks no plaintext', !atob(blob.ct).includes('token: abc123'));

// 3. wrong passphrase fails
const wrong = await V.unlock('correct horse battery stapl', { ...meta });
let threw = false;
try { await V.decrypt(wrong, blob); } catch { threw = true; }
ok('wrong passphrase is rejected', threw);

// 4. tampered ciphertext fails (GCM integrity, not just secrecy)
const bytes = Uint8Array.from(atob(blob.ct), c => c.charCodeAt(0));
bytes[10] ^= 0xff;
let tamperThrew = false;
try { await V.decrypt(key, { iv: blob.iv, ct: btoa(String.fromCharCode(...bytes)) }); } catch { tamperThrew = true; }
ok('tampered ciphertext is rejected', tamperThrew);

// 5. IV never reused across writes
const ivs = new Set();
for (let i = 0; i < 200; i++) ivs.add((await V.encrypt(key, notes[0])).iv);
ok('200 writes produced 200 distinct IVs', ivs.size === 200);

// 6. correct passphrase re-derived from stored salt works
const re = await V.unlock('correct horse battery staple', meta);
ok('re-derive from stored salt decrypts', JSON.stringify(await V.decrypt(re, blob)) === JSON.stringify(notes));

// 7. salt is random per vault
const a = await V.create('same passphrase'), b = await V.create('same passphrase');
ok('each vault gets a distinct salt', a.meta.salt !== b.meta.salt);

// 8. session cache expiry
await V.cache(key);
ok('key is cached for the session', !!(await V.cached()));
session.vaultkey.until = Date.now() - 1;
ok('expired cache auto-locks', (await V.cached()) === null);
ok('expired cache is wiped, not just refused', !session.vaultkey);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
