const q = await import(new URL('../src/lib/queue.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };

// ---- klasifikasi error ----
const rpc = (code, message) => q.classifyRpcError({ code, message }).kind;
ok(rpc('', 'TypeError: Failed to fetch') === 'transient', 'fetch gagal (kode kosong) => sementara');
ok(rpc(null, 'x') === 'transient', 'tanpa kode => sementara');
ok(rpc('PGRST301', 'JWT expired') === 'transient', 'JWT kedaluwarsa => sementara (tunggu refresh)');
ok(rpc('PGRST000', 'could not connect') === 'transient' && rpc('08006', 'connection failure') === 'transient', 'masalah koneksi database => sementara');
ok(rpc('P0001', 'Tugas yang sudah ditutup tidak dapat diubah') === 'rejected', 'aturan server (P0001) => ditolak');
ok(rpc('42501', 'permission denied') === 'rejected', 'tidak berwenang => ditolak');
ok(rpc('23514', 'check violation') === 'rejected', 'pelanggaran constraint => ditolak');
ok(rpc('PGRST116', 'x') === 'rejected', 'PGRST116 (bukan koneksi) => ditolak');

const st = (statusCode, message) => q.classifyStorageError({ statusCode, message }).kind;
ok(st('409', 'The resource already exists') === 'ok' && st(undefined, 'Duplicate') === 'ok', 'foto sudah ada => dianggap sukses');
ok(st(undefined, 'Failed to fetch') === 'transient', 'upload tanpa jaringan => sementara');
ok(st('413', 'Payload too large') === 'rejected' && st('415', 'mime') === 'rejected', 'terlalu besar / tipe salah => ditolak');
ok(st('400', 'exp claim timestamp check failed jwt expired') === 'transient', 'token kedaluwarsa di storage => sementara');
ok(st('503', 'unavailable') === 'transient', '5xx => sementara');

// ---- flush ----
const blob = (n) => ({ size: n });
function item(o = {}) {
  return { id: 'a', userId: 'u1', taskId: 't1', taskTitle: 'T', payload: { status: 'done', progress: 100, note: null, urgent: false },
    photos: [{ path: 't1/1.jpg', blob: blob(1), uploaded: false }], createdAt: 1, state: 'pending', error: null, ...o };
}
function mem(items) {
  const m = new Map(items.map((i) => [i.id, structuredClone(i)]));
  return { m, list: async () => [...m.values()].map((i) => ({ ...i, photos: i.photos.map((p) => ({ ...p })) })),
    put: async (i) => { m.set(i.id, structuredClone(i)); }, remove: async (id) => { m.delete(id); } };
}
function remote(o = {}) {
  const calls = [];
  return { calls, upload: async (p) => { calls.push('up:' + p); return (o.upload?.(p)) ?? { kind: 'ok' }; },
    report: async (i) => { calls.push('rep:' + i.id); return (o.report?.(i)) ?? { kind: 'ok' }; } };
}

let s = mem([item()]), r = remote();
let res = await q.flush(s, r, 'u1');
ok(res.sent.length === 1 && s.m.size === 0 && r.calls.join() === 'up:t1/1.jpg,rep:a', 'sukses: foto diunggah lalu dilaporkan, item dihapus', r.calls);

s = mem([item()]); r = remote({ upload: () => ({ kind: 'transient', message: 'offline' }) });
res = await q.flush(s, r, 'u1');
ok(res.stopped && s.m.size === 1 && !r.calls.includes('rep:a'), 'offline saat unggah foto => berhenti, item tetap, belum melapor');

s = mem([item()]); r = remote({ report: () => ({ kind: 'transient', message: 'offline' }) });
res = await q.flush(s, r, 'u1');
ok(res.stopped && s.m.get('a').photos[0].uploaded === true && s.m.get('a').state === 'pending', 'gagal sementara saat melapor: foto tersimpan sebagai terunggah, item tetap antre');
r = remote();
res = await q.flush(s, r, 'u1');
ok(res.sent.length === 1 && !r.calls.some((c) => c.startsWith('up:')), 'kiriman ulang: foto TIDAK diunggah lagi, laporan terkirim');

s = mem([item()]); r = remote({ report: () => ({ kind: 'rejected', message: 'Tugas sudah ditutup' }) });
res = await q.flush(s, r, 'u1');
ok(res.rejected.length === 1 && s.m.get('a').state === 'rejected' && s.m.get('a').error === 'Tugas sudah ditutup', 'ditolak server => ditandai rejected dengan pesan');
r = remote();
res = await q.flush(s, r, 'u1');
ok(res.sent.length === 0 && r.calls.length === 0, 'item rejected tidak dicoba lagi');

s = mem([item({ id: 'x' })]); r = remote({ upload: () => ({ kind: 'rejected', message: 'Foto ditolak: terlalu besar' }) });
res = await q.flush(s, r, 'u1');
ok(res.rejected.length === 1 && !r.calls.includes('rep:x'), 'foto ditolak => item rejected, tidak melapor tanpa foto');

s = mem([item({ id: 'bad', createdAt: 1 }), item({ id: 'good', createdAt: 2, photos: [] })]);
r = remote({ report: (i) => (i.id === 'bad' ? { kind: 'rejected', message: 'x' } : { kind: 'ok' }) });
res = await q.flush(s, r, 'u1');
ok(res.sent.join() === 'good' && res.rejected.length === 1, 'item ditolak tidak memblokir item berikutnya');

s = mem([item({ id: 'b2', createdAt: 5, photos: [] }), item({ id: 'b1', createdAt: 2, photos: [] })]);
r = remote();
await q.flush(s, r, 'u1');
ok(r.calls.join() === 'rep:b1,rep:b2', 'dikirim berurutan menurut waktu dibuat', r.calls);

s = mem([item({ id: 'mine', photos: [] }), item({ id: 'theirs', userId: 'u2', photos: [] })]);
r = remote();
res = await q.flush(s, r, 'u1');
ok(res.sent.join() === 'mine' && s.m.has('theirs') && !r.calls.includes('rep:theirs'), 'update milik pengguna lain TIDAK dikirim atas nama pengguna ini');

s = mem([]); r = remote();
res = await q.flush(s, r, 'u1');
ok(res.sent.length === 0 && !res.stopped, 'antrean kosong aman');

console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
