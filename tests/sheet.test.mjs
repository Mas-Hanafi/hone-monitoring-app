const base = new URL('../supabase/functions/sync-sheet/', import.meta.url).href;
const { toRow, planWrites, HEADERS } = await import(base + 'sheet.ts');
const { runSync } = await import(base + 'sync.ts');
const { getAccessToken, sheetClient } = await import(base + 'google.ts');
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };

const rec = (o = {}) => ({ id: 'i' + (o.task_no ?? 1), task_no: 1, title: 'Cat lobi', status: 'in_progress', approval: 'rejected', progress: 50, is_urgent: true,
  deadline: '2026-11-20', started_at: '2026-11-02T03:00:00Z', completed_at: null, cancelled_at: null, latest_note: 'nunggu cat',
  last_update_at: '2026-11-05T17:30:00Z', requester: { name: 'FO' }, pic: { full_name: 'Ani' }, dept: { name: 'Sipil' }, ...o });

// toRow
let r = toRow(rec());
ok(r.length === HEADERS.length, 'jumlah kolom = jumlah header', r.length);
ok(r[5] === 50 && r[6] === 'Urgent' && r[7] === 'Dikerjakan' && r[8] === 'Reject' && r[10] === '2026-11-02', 'progress angka, urgensi, status + approval Indonesia, tanggal mulai WIB');
ok(r[13] === '2026-11-06 00:30:00', 'update terakhir dikonversi ke WIB (UTC+7)', r[13]);
r = toRow(rec({ status: 'cancelled', cancelled_at: '2026-11-07T10:00:00Z', latest_note: null, requester: null }));
ok(r[11] === '2026-11-07' && r[12] === '' && r[2] === '', 'batal => kolom Selesai terisi, null jadi kosong');

// planWrites
const colA = [['No'], [1], [], [3], ['4']];
const p = planWrites(colA, [{ taskNo: 4, row: ['a'] }, { taskNo: 1, row: ['b'] }, { taskNo: 9, row: ['c'] }, { taskNo: 2, row: ['d'] }], "Tu'gas");
ok(p.updates.length === 2 && p.updates[0].range === "'Tu''gas'!A2:N2" && p.updates[1].range === "'Tu''gas'!A5:N5", 'update ke baris yang benar, nama tab di-escape', p.updates.map(u => u.range));
ok(p.appends.length === 2 && p.appends[0][0] === 'd' && p.appends[1][0] === 'c', 'yang belum ada ditambahkan berurutan nomor');
ok(planWrites([['No']], [{ taskNo: 1, row: ['x'] }], 'T').appends.length === 1, 'sheet hanya header => append');
ok(planWrites([[1]], [{ taskNo: 1, row: ['x'] }], 'T').updates.length === 0, 'baris 1 dianggap header, tidak ditimpa');

// runSync
function deps({ colA = [['No']], outbox, failAppend = false } = {}) {
  const log = { acked: 0, header: 0, upd: [], app: [], order: [] };
  let box = outbox ?? [{ task_id: 'i1', queued_at: 'q1' }, { task_id: 'i2', queued_at: 'q2' }];
  return { log, d: {
    readOutbox: async (n) => box.slice(0, n),
    fetchTasks: async (ids) => ids.map((id) => rec({ id, task_no: Number(id.slice(1)) })),
    ack: async (items) => { log.order.push('ack'); log.acked += items.length; box = box.filter(b => !items.includes(b)); },
    sheet: { tab: 'Tugas', readColumnA: async () => colA, writeHeader: async () => { log.header++; log.order.push('hdr'); },
      update: async (u) => { log.upd.push(...u); log.order.push('upd'); },
      append: async (rows) => { if (failAppend) throw new Error('quota'); log.app.push(...rows); log.order.push('app'); } } } };
}
let t = deps({ colA: [] });
let res = await runSync(t.d);
ok(t.log.header === 1 && res.appended === 2 && t.log.acked === 2 && t.log.order.at(-1) === 'ack', 'sheet kosong => header ditulis, 2 baris ditambah, ack paling akhir', [res, t.log.order]);
t = deps({ colA: [['No'], [1]] });
res = await runSync(t.d);
ok(res.updated === 1 && res.appended === 1 && t.log.header === 0, 'baris lama di-update, baru ditambah');
t = deps({ failAppend: true });
const e = await runSync(t.d).catch(x => x.message);
ok(e === 'quota' && t.log.acked === 0, 'gagal tulis => tidak ada ack (antrean utuh)');
t = deps();
res = await runSync(t.d, { dryRun: true });
ok(res.queued === 2 && res.appended === 0 && t.log.acked === 0 && t.log.app.length === 0, 'dry run hanya menghitung');
t = deps({ outbox: [] });
res = await runSync(t.d);
ok(res.queued === 0, 'antrean kosong => tidak ada kerja');
t = deps({ colA: [['No']], outbox: Array.from({ length: 5 }, (_, i) => ({ task_id: 'i' + (i + 1), queued_at: 'q' + i })) });
res = await runSync(t.d, { batch: 2, maxBatches: 10 });
ok(res.queued === 5 && t.log.acked === 5, 'beberapa batch (2+2+1)', res);

// google
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
let sent;
const tokenFetch = async (url, init) => { sent = { url, body: new URLSearchParams(init.body) }; return new Response(JSON.stringify({ access_token: 'tok123' })); };
const tok = await getAccessToken({ client_email: 'svc@x.iam.gserviceaccount.com', private_key: pem }, tokenFetch, 1000);
const [h, c, s] = sent.body.get('assertion').split('.');
const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${c}`));
ok(tok === 'tok123' && valid, 'JWT RS256 ditandatangani benar (verifikasi dengan kunci publik)');
ok(claims.iss === 'svc@x.iam.gserviceaccount.com' && claims.scope.endsWith('/spreadsheets') && claims.exp - claims.iat === 3600 && sent.body.get('grant_type').includes('jwt-bearer'), 'klaim JWT: iss, scope, masa berlaku 1 jam', claims);

const calls = [];
const f = async (url, init = {}) => { calls.push({ url, init }); return new Response(JSON.stringify({ values: [['No'], [1]] })); };
const sc = sheetClient('T', 'SHEET/1', "Tu'gas", f);
await sc.readColumnA(); await sc.append([['=HYPERLINK("http://x","y")']]); await sc.update([{ range: 'A2:M2', values: [['z']] }]); await sc.writeHeader();
ok(calls[0].url.includes('/spreadsheets/SHEET%2F1/values/') && calls[0].url.includes(encodeURIComponent("'Tu''gas'!A:A")), 'URL: id sheet dan nama tab di-encode');
ok(calls[1].url.includes('valueInputOption=RAW') && calls[1].url.includes(':append') && calls[1].init.headers.authorization === 'Bearer T', 'append memakai RAW (rumus tidak dieksekusi)');
ok(JSON.parse(calls[2].init.body).valueInputOption === 'RAW', 'batchUpdate memakai RAW');
ok(calls[3].init.method === 'PUT' && calls[3].url.includes('valueInputOption=RAW'), 'header ditulis RAW');
const bad = sheetClient('T', 's', 'T', async () => new Response('x'.repeat(1000) + 'SECRET', { status: 403 }));
const msg = await bad.readColumnA().catch(x => x.message);
ok(msg.includes('HTTP 403') && msg.length < 400 && !msg.includes('SECRET'), 'pesan error Google dipotong');

console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
