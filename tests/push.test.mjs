const p = await import(new URL('../supabase/functions/send-push/push.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };

const NOW = Date.parse('2026-11-08T05:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const notif = (o = {}) => ({ id: 1, user_id: 'u1', type: 'task_assigned', title: 'Tugas baru', body: 'Cat lobi', task_id: 't1', created_at: iso(1000), ...o });
const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const sub = (o = {}) => ({ endpoint: FCM, user_id: 'u1', p256dh: 'k', auth_secret: 'a', ...o });

function run({ pending = [notif()], subs = [sub()], results = {} } = {}) {
  const log = { sent: [], pushed: null, removed: null };
  const deps = {
    now: () => NOW,
    readPending: async () => pending,
    readSubs: async () => subs,
    send: async (s, payload) => { log.sent.push({ endpoint: s.endpoint, payload }); return results[s.endpoint] ?? 'ok'; },
    markPushed: async (ids) => { log.pushed = ids; },
    removeSubs: async (e) => { log.removed = e; },
  };
  return { deps, log };
}

// endpoint
for (const good of [FCM, 'https://android.googleapis.com/gcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q', 'https://db5p.notify.windows.com/?token=x'])
  ok(p.isAllowedEndpoint(good), 'endpoint diizinkan: ' + good.slice(8, 40));
for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://169.254.169.254/', 'https://localhost/x', 'ftp://fcm.googleapis.com/x'])
  ok(!p.isAllowedEndpoint(bad), 'endpoint ditolak: ' + bad.slice(0, 40));

// payload
const pl = p.toPayload(notif());
ok(pl.title === 'Tugas baru' && pl.body === 'Cat lobi' && pl.url === '/' && pl.tag === 'task_assigned:t1', 'payload: judul, isi, url relatif, tag');
ok(p.toPayload(notif({ task_id: null, id: 9 })).tag === 'task_assigned:9', 'tag tanpa tugas memakai id notifikasi');

// deliver
let t = run();
let r = await p.deliver(t.deps);
ok(r.sent === 1 && t.log.pushed.join() === '1' && r.retry === 0, 'sukses: terkirim dan ditandai');

t = run({ pending: [] });
r = await p.deliver(t.deps);
ok(r.notifications === 0 && t.log.pushed === null && t.log.sent.length === 0, 'tidak ada yang menunggu => tidak ada kerja');

t = run({ subs: [] });
r = await p.deliver(t.deps);
ok(r.sent === 0 && t.log.pushed.join() === '1', 'tanpa langganan => ditandai (in-app tetap ada), tidak terus diulang');

t = run({ subs: [sub({ user_id: 'u2' })] });
r = await p.deliver(t.deps);
ok(t.log.sent.length === 0 && t.log.pushed.join() === '1', 'langganan milik orang lain tidak dipakai');

t = run({ results: { [FCM]: 'gone' } });
r = await p.deliver(t.deps);
ok(r.removedSubs === 1 && t.log.removed.join() === FCM && t.log.pushed.join() === '1', 'langganan mati (404/410) dihapus, notifikasi ditandai');

t = run({ results: { [FCM]: 'error' } });
r = await p.deliver(t.deps);
ok(r.retry === 1 && t.log.pushed === null, 'gagal sementara & masih baru => tidak ditandai (dicoba lagi)');

t = run({ pending: [notif({ created_at: iso(2 * 3600_000) })], results: { [FCM]: 'error' } });
r = await p.deliver(t.deps);
ok(r.retry === 0 && t.log.pushed.join() === '1', 'gagal sementara tapi sudah > 1 jam => menyerah (push basi tidak berguna)');

const A = 'https://fcm.googleapis.com/fcm/send/dev-a', B = 'https://web.push.apple.com/B';
t = run({ subs: [sub({ endpoint: A }), sub({ endpoint: B })], results: { [A]: 'error', [B]: 'ok' } });
r = await p.deliver(t.deps);
ok(r.sent === 1 && t.log.pushed.join() === '1' && r.retry === 0, 'satu perangkat sukses, satu gagal => dianggap terkirim');

t = run({ subs: [sub({ endpoint: 'https://evil.example.com/x' })] });
r = await p.deliver(t.deps);
ok(t.log.sent.length === 0 && t.log.removed.join() === 'https://evil.example.com/x' && t.log.pushed.join() === '1', 'endpoint tak dikenal: tidak diakses, langganan dibuang');

t = run({ pending: [notif({ id: 1 }), notif({ id: 2, user_id: 'u2' })], subs: [sub(), sub({ endpoint: B, user_id: 'u2' })], results: { [B]: 'error' } });
r = await p.deliver(t.deps);
ok(t.log.pushed.join() === '1' && r.retry === 1, 'campuran: yang sukses ditandai, yang gagal diulang');

// kunci VAPID base64url -> byte
const { urlBase64ToUint8Array: dec } = await import(new URL('../src/lib/vapid.ts', import.meta.url).href);
ok(Array.from(dec('AQAB')).join() === '1,0,1', 'base64url sederhana (AQAB => 1,0,1)');
ok(Array.from(dec('-_8')).join() === '251,255', 'karakter - dan _ diterjemahkan, padding ditambahkan');
const real = Buffer.from(crypto.getRandomValues(new Uint8Array(65))).toString('base64url');
ok(Buffer.from(dec(real)).toString('base64url') === real && dec(real).length === 65, 'kunci publik 65 byte bolak-balik utuh');

console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
