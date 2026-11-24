import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Uji rutin ME (genset, panel, room): hak akses, kelengkapan, nilai sah, NG, periode, bukti TTD+foto, buka ulang.
const SCHEMA = fileURLToPath(new URL('../schema.sql', import.meta.url));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + label + (c ? '' : '  ' + extra)); };

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
`);
try { await db.exec(readFileSync(SCHEMA, 'utf8')); ok(true, 'skema termuat tanpa error'); }
catch (e) { ok(false, 'skema termuat', e.message); process.exit(1); }

// stf/spv = tim ME (dept 14). mgr = manager di luar ME (hanya melihat). mme = manager ME. req/rstf = departemen lain.
const U = { mgr: '00000000-0000-0000-0000-000000000001', spv: '00000000-0000-0000-0000-000000000002',
            stf: '00000000-0000-0000-0000-000000000003', req: '00000000-0000-0000-0000-000000000099',
            rstf: '00000000-0000-0000-0000-000000000098', mme: '00000000-0000-0000-0000-000000000005' };
await db.exec(`
insert into auth.users (id) values ('${U.mgr}'), ('${U.spv}'), ('${U.stf}'), ('${U.req}'), ('${U.rstf}'), ('${U.mme}');
insert into profiles (id, full_name, role, department_id) values
 ('${U.mgr}', 'Mgr', 'manager', 1), ('${U.spv}', 'Spv', 'supervisor', 14), ('${U.stf}', 'Staff4', 'staff', 14),
 ('${U.req}', 'Req', 'supervisor', 5), ('${U.rstf}', 'ReqStaff', 'staff', 5), ('${U.mme}', 'MgrME', 'manager', 14);
`);
async function as(who, fn) {
  await db.query("select set_config('test.uid', $1, false)", [U[who]]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const q = (who, sql, params = []) => as(who, () => db.query(sql, params)).then(r => r.rows);
const err = async (who, sql, params = []) => { try { await q(who, sql, params); return null; } catch (e) { return e.message; } };
const J = JSON.stringify;

const today = (await db.query("select (now() at time zone 'Asia/Jakarta')::date::text d")).rows[0].d;
const monday = (await db.query("select date_trunc('week', (now() at time zone 'Asia/Jakarta'))::date::text d")).rows[0].d;
// berkas bukti: baris storage.objects dibuat langsung (stand-in unggahan klien)
async function files(who, key, { photos = 1, signature = 1, uploaded = true, uid = U[who] } = {}) {
  const period = key === 'room' ? monday : today;
  const out = [];
  const add = async (kind, n) => {
    const path = `${key}/${period}/${uid}/${kind}-${n}-${Math.random().toString(36).slice(2)}.png`;
    if (uploaded) await db.query("insert into storage.objects (bucket_id, name) values ('routine-files', $1)", [path]);
    out.push({ kind, path });
  };
  for (let i = 0; i < signature; i++) await add('signature', i);
  for (let i = 0; i < photos; i++) await add('photo', i);
  return out;
}

// jawaban lengkap: semua butir terjawab "ok" (angka 220 untuk number), kecuali yang dikecualikan
async function answers(key, override = () => null, skip = () => false) {
  const items = (await db.query(`select i.id, i.kind, i.scope, i.label from routine_items i join routine_templates t on t.id = i.template_id where t.key = $1 and i.is_active`, [key])).rows;
  const subs = (await db.query(`select s.id from routine_subjects s join routine_templates t on t.id = s.template_id where t.key = $1 and s.is_active`, [key])).rows;
  const out = [];
  for (const it of items) for (const sid of it.scope === 'run' ? [null] : subs.map(s => s.id)) {
    if (it.kind === 'text') continue;
    if (skip(it, sid)) continue;
    const base = it.kind === 'number' ? { status: 'ok', num: 220 } : { status: 'ok' };
    out.push({ item_id: it.id, subject_id: sid, ...base, ...(override(it, sid) ?? {}) });
  }
  return out;
}

// ---- data awal ----
ok((await db.query('select count(*)::int c from routine_templates')).rows[0].c === 3, '3 checklist: genset, panel, room');
const cnt = async (k) => (await db.query("select count(*)::int c from routine_subjects s join routine_templates t on t.id=s.template_id where t.key=$1", [k])).rows[0].c;
ok(await cnt('room') === 30, 'room: 30 kamar');
ok(await cnt('genset') === 2, 'genset: 2 unit');
ok(await cnt('panel') === 16, 'panel: 16 panel');
ok((await db.query("select count(*)::int c from routine_items i join routine_templates t on t.id=i.template_id where t.key='room' and i.label in ('Filter pool','Cool storage') and i.kind='check'")).rows[0].c === 2, 'room: filter pool dan cool storage wajib OK/NG (tanpa N/A)');

// ---- hak akses ----
ok((await q('stf', 'select id from routine_templates')).length === 3, 'staff ME bisa membaca checklist');
ok((await q('mgr', 'select id from routine_templates')).length === 3, 'manager di luar ME bisa membaca');
ok((await q('req', 'select id from routine_templates')).length === 3, 'SPV departemen lain (pimpinan) bisa membaca');
ok((await q('rstf', 'select id from routine_templates')).length === 0, 'staff departemen lain tidak melihat rutin');
ok((await q('stf', 'select can_fill_routine() f'))[0].f === true && (await q('mgr', 'select can_fill_routine() f'))[0].f === false, 'hanya tim ME yang boleh mengisi');
const full = await answers('genset');
const runCheck = (await db.query("select i.id from routine_items i join routine_templates t on t.id=i.template_id where t.key='genset' and i.kind='check' and i.scope='run' order by i.sort limit 1")).rows[0].id;
for (const who of ['mgr', 'req', 'rstf']) {
  ok((await err(who, 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files(who, 'genset'))]) || '').includes('Hanya tim ME'), `${who} tidak boleh mengisi`);
}
ok((await err('stf', 'insert into routine_runs (template_id, template_version, period, inspector_id) values (1,1,now(),$1)', [U.stf]) || '').includes('permission denied'), 'insert langsung ke routine_runs ditolak');

// ---- validasi jawaban ----
const okFiles = () => files('stf', 'genset');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full.slice(1)), J(await okFiles())]) || '').includes('belum diisi'), 'butir kurang ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J([...full, full[0]]), J(await okFiles())]) || '').includes('ganda'), 'isian ganda ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J([...full, { item_id: 99999, subject_id: null, status: 'ok' }]), J(await okFiles())]) || '').includes('tidak cocok'), 'butir asing ditolak');
const ngNoNote = await answers('genset', (it) => it.id === runCheck ? { status: 'ng' } : null);
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(ngNoNote), J(await okFiles())]) || '').includes('wajib diberi catatan'), 'NG tanpa catatan ditolak');
const numMissing = await answers('genset', (it) => it.kind === 'number' ? { status: 'ok', num: null } : null);
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(numMissing), J(await okFiles())]) || '').includes('tidak sah'), 'butir angka tanpa angka ditolak');
const naOnCheck = await answers('genset', (it) => it.kind === 'check' ? { status: 'na' } : null);
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(naOnCheck), J(await okFiles())]) || '').includes('tidak sah'), 'N/A pada butir OK/NG ditolak');

// ---- validasi bukti (TTD + foto) ----
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files('stf', 'genset', { signature: 0 }))]) || '').includes('Tanda tangan wajib'), 'tanpa tanda tangan ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files('stf', 'genset', { signature: 2 }))]) || '').includes('Tanda tangan wajib'), 'dua tanda tangan ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files('stf', 'genset', { photos: 0 }))]) || '').includes('1 sampai 6 foto'), 'tanpa foto ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files('stf', 'genset', { photos: 7 }))]) || '').includes('1 sampai 6 foto'), '7 foto ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files('stf', 'genset', { uploaded: false }))]) || '').includes('belum terunggah'), 'berkas yang belum diunggah ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(full), J(await files('stf', 'genset', { uid: U.spv }))]) || '').includes('tidak sah'), 'berkas milik orang lain ditolak');
ok((await err('stf', 'select submit_routine_run($1,$2)', ['genset', J(full)]) || '').includes('Tanda tangan wajib'), 'tanpa berkas sama sekali ditolak');
ok((await db.query('select count(*)::int c from routine_runs')).rows[0].c === 0, 'tidak ada isian tersimpan setelah semua penolakan');

// ---- kirim genset dengan 1 NG ----
const g = await answers('genset', (it) => it.id === runCheck ? { status: 'ng', note: 'Ruangan kotor' } : null);
const gFiles = await files('stf', 'genset', { photos: 2 });
const runId = (await q('stf', 'select submit_routine_run($1,$2,$3) id', ['genset', J(g), J(gFiles)]))[0].id;
const run = (await db.query('select ng_count, inspector_id, period, template_version from routine_runs where id=$1', [runId])).rows[0];
ok(run.ng_count === 1 && run.inspector_id === U.stf && run.template_version === 1, 'isian tersimpan: ng_count 1, pengisi tercatat');
ok(String(run.period.toISOString?.().slice(0, 10) ?? run.period) === today, 'periode harian = hari ini WIB');
ok((await db.query('select count(*)::int c from routine_answers where run_id=$1', [runId])).rows[0].c === g.length, 'semua jawaban tersimpan');
ok((await db.query("select count(*)::int c from routine_files where run_id=$1 and kind='signature'", [runId])).rows[0].c === 1
   && (await db.query("select count(*)::int c from routine_files where run_id=$1 and kind='photo'", [runId])).rows[0].c === 2, 'bukti tersimpan: 1 tanda tangan, 2 foto');
ok((await q('mgr', 'select id from routine_files')).length === 3, 'manager di luar ME bisa melihat berkas bukti');
ok((await q('rstf', 'select id from routine_files')).length === 0, 'staff departemen lain tidak melihat berkas bukti');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(g), J(await files('stf', 'genset'))]) || '').includes('sudah diisi'), 'periode yang sama tidak bisa diisi dua kali');

// ---- unggah ke bucket ----
ok(!(await err('stf', "insert into storage.objects (bucket_id, name) values ('routine-files', $1)", [`genset/${today}/${U.stf}/x.png`])), 'tim ME bisa mengunggah ke folder sendiri');
ok((await err('stf', "insert into storage.objects (bucket_id, name) values ('routine-files', $1)", [`genset/${today}/${U.spv}/x.png`]) || '').includes('row-level security'), 'unggah ke folder orang lain ditolak');
ok((await err('mgr', "insert into storage.objects (bucket_id, name) values ('routine-files', $1)", [`genset/${today}/${U.mgr}/x.png`]) || '').includes('row-level security'), 'manager di luar ME tidak bisa mengunggah');
ok((await q('mgr', "select name from storage.objects where bucket_id='routine-files' limit 1")).length === 1, 'manager di luar ME bisa membaca berkas');

// ---- notifikasi NG ----
const notif = (await db.query("select user_id from notifications where type='routine_ng'")).rows.map(r => r.user_id);
ok([U.mgr, U.spv, U.mme, U.req, U.rstf].every(u => notif.includes(u)) && !notif.includes(U.stf), 'NG: semua akun aktif dikabari, kecuali pengisi');
ok((await db.query("select title from notifications where type='routine_ng' and user_id=$1", [U.req])).rows[0].title === 'Temuan NG: Genset', 'NG: judul notifikasi "Temuan NG: Genset"');

let panelIds;
// ---- panel per panel: tiap panel dikirim sendiri-sendiri, oleh siapa pun di tim ME ----
{
  ok((await db.query("select mode, subject_noun from routine_templates where key='panel'")).rows[0].mode === 'per_subject', 'panel memakai mode per_subject');
  panelIds = (await db.query("select s.id from routine_subjects s join routine_templates t on t.id=s.template_id where t.key='panel' order by s.sort")).rows.map(r => r.id);
  const one = (sid) => answers('panel', (it) => it.kind === 'number' ? { status: 'na', num: null } : (it.kind === 'check_na' ? { status: 'na' } : null), (it, s2) => s2 !== sid);
  const a1 = await one(panelIds[0]);
  ok(new Set(a1.map(a => a.subject_id)).size === 1, 'panel: satu panel per kiriman');
  const r1 = await q('stf', 'select submit_routine_run($1,$2,$3) id', ['panel', J(a1), J(await files('stf', 'panel'))]);
  ok(!!r1[0].id, 'akun A mengirim Panel 1 saja');
  ok((await err('spv', 'select submit_routine_run($1,$2,$3)', ['panel', J(await one(panelIds[1])), J(await files('spv', 'panel'))])) === null, 'akun B langsung bisa mengirim Panel 2 pada hari yang sama');
  ok((await err('mme', 'select submit_routine_run($1,$2,$3)', ['panel', J(a1), J(await files('mme', 'panel'))]) || '').includes('Sudah diperiksa periode ini'), 'Panel 1 tidak bisa dikirim dua kali pada hari yang sama');
  ok((await err('mme', 'select submit_routine_run($1,$2,$3)', ['panel', '[]', J(await files('mme', 'panel'))]) || '').includes('minimal satu panel'), 'tanpa panel ditolak dengan sebutan "panel"');
  const nb = (await db.query("select body from notifications where type in ('routine','routine_ng') and body like '%checklist Panel%' order by id desc limit 1")).rows[0].body;
  ok(nb.includes('(Panel 2)') && !nb.includes('panel Panel'), 'notifikasi menyebut panel yang dikirim tanpa kata ganda');
  ok((await db.query("select count(*)::int c from routine_run_subjects rs join routine_templates t on t.id=rs.template_id where t.key='panel'")).rows[0].c === 2, 'dua panel tercatat terperiksa hari ini');
}
// ---- panel (16 panel, N/A diizinkan, teks opsional) dan room mingguan ----
// sisa 14 panel (Panel 1 dan 2 sudah dikirim di atas) dikirim sekaligus oleh satu akun: tetap sah
const p = await answers('panel', (it) => it.kind === 'number' ? { status: 'na', num: null } : (it.kind === 'check_na' ? { status: 'na' } : null), (it, sid) => sid === panelIds[0] || sid === panelIds[1]);
ok(new Set(p.map(a => a.subject_id)).size === 14, 'panel: 14 panel tersisa dalam satu kiriman');
const notifBefore = (await db.query('select coalesce(max(id), 0)::int m from notifications')).rows[0].m;
ok(!(await err('stf', 'select submit_routine_run($1,$2,$3)', ['panel', J(p), J(await files('stf', 'panel'))])), 'panel: semua N/A sah');
const okNotif = (await db.query("select user_id, title, body from notifications where type='routine' and id > $1", [notifBefore])).rows;
ok(okNotif.length === 5 && !okNotif.some(r => r.user_id === U.stf) && okNotif.every(r => r.title === 'Checklist Panel selesai' && r.body.includes('Semua OK') && r.body.includes('Staff4')), 'isian tanpa temuan juga dikabari ke semua akun aktif (5 penerima, pengisi tidak)');
// ---- room: mode per kamar (kamar terisi tamu boleh dilewati) ----

const roomIds = (await db.query("select s.id from routine_subjects s join routine_templates t on t.id=s.template_id where t.key='room' order by s.sort")).rows.map(r => r.id);
const textItem = (await db.query("select i.id from routine_items i join routine_templates t on t.id=i.template_id where t.key='room' and i.kind='text'")).rows[0].id;
const onlyRooms = (ids, extra = () => null, skipItem = () => false) =>
  answers('room', extra, (it, sid) => !ids.includes(sid) || skipItem(it, sid));
ok((await db.query("select mode from routine_templates where key='room'")).rows[0].mode === 'per_subject', 'room memakai mode per_subject');
ok((await err('spv', 'select submit_routine_run($1,$2,$3)', ['room', '[]', J(await files('spv', 'room'))]) || '').includes('minimal satu kamar'), 'room: tanpa kamar ditolak');
const room1 = await onlyRooms([roomIds[0]]);
const roomIncomplete = await onlyRooms([roomIds[1]], () => null, (it) => it.label === 'Lampu');
ok((await err('spv', 'select submit_routine_run($1,$2,$3)', ['room', J(roomIncomplete), J(await files('spv', 'room'))]) || '').includes('belum diisi'), 'room: kamar yang dipilih tapi butirnya kurang ditolak');
const run1 = (await q('spv', 'select submit_routine_run($1,$2,$3) id', ['room', J(room1), J(await files('spv', 'room'))]))[0].id;
ok(!!run1, 'room: cukup satu kamar boleh dikirim (kamar lain terisi tamu)');
ok((await db.query('select count(*)::int c from routine_answers where run_id=$1', [run1])).rows[0].c === room1.length, 'room: hanya jawaban kamar itu yang tersimpan');
ok((await err('stf', 'select submit_routine_run($1,$2,$3)', ['room', J(room1), J(await files('stf', 'room'))]) || '').includes('Sudah diperiksa periode ini'), 'room: kamar yang sama tidak bisa diperiksa dua kali dalam seminggu');
const rest = await onlyRooms(roomIds.slice(1), (it, sid) => null);
const restWithNote = [...rest, { item_id: textItem, subject_id: roomIds[1], status: 'ok', note: 'Catatan kamar' }];
const run2 = (await q('stf', 'select submit_routine_run($1,$2,$3) id', ['room', J(restWithNote), J(await files('stf', 'room'))]))[0].id;
ok(!!run2, 'room: kamar sisanya dikirim di isian kedua pada minggu yang sama');
ok((await db.query("select count(*)::int c from routine_runs r join routine_templates t on t.id=r.template_id where t.key='room'")).rows[0].c === 2, 'room: dua isian dalam satu minggu');
ok((await db.query("select count(*)::int c from routine_run_subjects rs join routine_templates t on t.id=rs.template_id where t.key='room'")).rows[0].c === 30, 'room: 30 kamar tercatat terperiksa');
ok((await err('spv', 'select submit_routine_run($1,$2,$3)', ['room', J(room1), J(await files('spv', 'room'))]) || '').includes('Sudah diperiksa'), 'room: semua kamar sudah diperiksa minggu ini');
const rp = (await db.query("select period::text p from routine_runs r join routine_templates t on t.id=r.template_id where t.key='room' limit 1")).rows[0].p;
ok((await db.query("select extract(isodow from $1::date)::int d", [rp])).rows[0].d === 1, 'periode mingguan jatuh pada hari Senin', rp);
ok((await q('mgr', "select count(*)::int c from routine_run_subjects rs join routine_templates t on t.id=rs.template_id where t.key='room'"))[0].c === 30 && (await q('rstf', "select count(*)::int c from routine_run_subjects rs join routine_templates t on t.id=rs.template_id where t.key='room'"))[0].c === 0, 'kamar terperiksa terbaca pimpinan, tidak oleh departemen lain');
// buka ulang isian room membebaskan kamarnya lagi
await q('mme', 'select reopen_routine_run($1)', [run1]);
ok((await db.query("select count(*)::int c from routine_run_subjects rs join routine_templates t on t.id=rs.template_id where t.key='room'")).rows[0].c === 29, 'room: buka ulang membebaskan kamar itu');
ok(!(await err('spv', 'select submit_routine_run($1,$2,$3)', ['room', J(room1), J(await files('spv', 'room'))])), 'room: kamar yang dibuka ulang bisa diisi lagi');

// ---- buka ulang ----
ok((await err('stf', 'select reopen_routine_run($1)', [runId]) || '').includes('manager ME'), 'staff tidak bisa membuka ulang');
ok((await err('mgr', 'select reopen_routine_run($1)', [runId]) || '').includes('manager ME'), 'manager di luar ME tidak bisa membuka ulang');
await q('mme', 'select reopen_routine_run($1)', [runId]);
ok((await db.query('select count(*)::int c from routine_runs where id=$1', [runId])).rows[0].c === 0, 'manager ME membuka ulang: isian dan berkas terhapus');
ok((await db.query('select count(*)::int c from routine_files where run_id=$1', [runId])).rows[0].c === 0, 'baris berkas ikut terhapus');
ok((await db.query("select count(*)::int c from admin_log where action='reopen_routine_run'")).rows[0].c === 2, 'buka ulang tercatat di admin_log (room dan genset)');
ok(!(await err('stf', 'select submit_routine_run($1,$2,$3)', ['genset', J(g), J(await files('stf', 'genset'))])), 'setelah dibuka ulang bisa diisi lagi');


// ---- tambah rutinitas baru ----
{
  const mk = (who, name, freq, mode, noun, subs, items) => q(who, 'select create_routine($1,$2,$3,$4,$5,$6) k', [name, freq, mode, noun, J(subs), J(items)]);
  const mkErr = (who, ...a) => err(who, 'select create_routine($1,$2,$3,$4,$5,$6)', [a[0], a[1], a[2], a[3], J(a[4]), J(a[5])]);
  const simple = [{ section: 'Umum', label: 'Lampu menyala', kind: 'check' }, { label: 'Suhu', kind: 'number', unit: 'C' }];
  ok((await q('mgr', 'select can_edit_routine() v'))[0].v === false, 'manager di luar ME belum terdaftar: tidak bisa menambah');
  ok((await mkErr('mgr', 'Cek Kolam', 'daily', 'whole', 'objek', [], simple) || '').includes('Hanya tim ME'), 'penolakan memakai pesan yang jelas');
  ok((await mkErr('rstf', 'Cek Kolam', 'daily', 'whole', 'objek', [], simple) || '').includes('Hanya tim ME'), 'staff departemen lain tidak bisa menambah');
  await db.exec(`update app_settings set value = '["${U.mgr}"]'::jsonb where key = 'routine_editor_ids'`);
  ok((await q('mgr', 'select can_edit_routine() v'))[0].v === true, 'akun yang didaftarkan (editor rutinitas) boleh menambah');
  ok((await q('rstf', 'select can_edit_routine() v'))[0].v === false, 'akun lain tetap tidak boleh');

  const bad = [
    [['', 'daily', 'whole', 'objek', [], simple], 'Nama rutinitas'],
    [['Cek A', 'monthly', 'whole', 'objek', [], simple], 'Frekuensi'],
    [['Cek A', 'daily', 'xx', 'objek', [], simple], 'Cara pengisian'],
    [['Cek A', 'daily', 'per_subject', 'objek', [], simple], 'membutuhkan daftar objek'],
    [['Cek A', 'daily', 'whole', 'objek', [], [{ label: 'x', kind: 'check', scope: 'subject' }]], 'membutuhkan daftar objek'],
    [['Cek A', 'daily', 'whole', 'objek', ['P1', 'P2'], simple], 'diisi per objek'],
    [['Cek A', 'daily', 'whole', 'objek', ['P1', 'p1'], [{ label: 'x', kind: 'check', scope: 'subject' }]], 'tidak boleh kembar'],
    [['Cek A', 'daily', 'whole', 'objek', [], [{ label: 'catatan saja', kind: 'text' }]], 'bukan hanya catatan'],
    [['Cek A', 'daily', 'whole', 'objek', [], []], '1 sampai 80'],
    [['Cek A', 'daily', 'whole', 'objek', [], [{ label: '', kind: 'check' }]], 'tidak valid'],
    [['Cek A', 'daily', 'whole', 'objek', [], [{ label: 'x', kind: 'aneh' }]], 'tidak valid'],
    [['Cek A', 'daily', 'whole', 'objek', [], [{ label: 'x', kind: 'check', scope: 'global' }]], 'tidak valid'],
    [['Cek A', 'daily', 'whole', 'objek', [''], [{ label: 'x', kind: 'check', scope: 'subject' }]], 'Nama objek'],
    [['Genset', 'daily', 'whole', 'objek', [], simple], 'Sudah ada'],
  ];
  for (const [a, msg] of bad) ok((await mkErr('stf', ...a) || '').includes(msg), `validasi ditolak: ${msg}`);
  ok((await db.query('select count(*)::int c from routine_templates')).rows[0].c === 3, 'semua yang ditolak tidak meninggalkan data');

  const k1 = (await mk('stf', 'Cek Kolam Renang', 'daily', 'whole', '', [], [{ section: 'Air', label: 'Kejernihan air', kind: 'check' }, { section: 'Air', label: 'pH', kind: 'number', unit: 'pH' }, { section: 'Air', label: 'Catatan', kind: 'text' }]))[0].k;
  ok(k1 === 'cek-kolam-renang', 'kunci dibentuk dari nama');
  const t1 = (await db.query('select id, mode, subject_noun, created_by, is_active from routine_templates where key=$1', [k1])).rows[0];
  ok(t1.mode === 'whole' && t1.subject_noun === 'objek' && t1.created_by === U.stf && t1.is_active, 'rutinitas tersimpan dengan pembuatnya');
  ok((await db.query('select count(*)::int c from routine_items where template_id=$1 and scope=$2', [t1.id, 'run'])).rows[0].c === 3, 'butir tersimpan (tanpa objek: semua sekali per isian)');
  ok((await db.query("select count(*)::int c from notifications where title='Rutinitas baru: Cek Kolam Renang'")).rows[0].c === 5, 'semua akun aktif lain dikabari (5 penerima)');
  ok((await db.query("select count(*)::int c from notifications where title='Rutinitas baru: Cek Kolam Renang' and user_id=$1", [U.stf])).rows[0].c === 0, 'pembuat tidak dikabari');
  ok((await mkErr('spv', 'cek kolam renang', 'daily', 'whole', 'objek', [], simple) || '').includes('Sudah ada'), 'nama kembar (beda huruf besar) ditolak');

  const a1 = await answers(k1);
  ok(a1.length === 2, 'butir wajib = 2 (catatan opsional)');
  ok(!(await err('spv', 'select submit_routine_run($1,$2,$3)', [k1, J(a1), J(await files('spv', k1))])), 'rutinitas baru bisa diisi dengan TTD dan foto');
  ok((await err('stf', 'select submit_routine_run($1,$2,$3)', [k1, J(a1), J(await files('stf', k1))]) || '').includes('sudah diisi'), 'aturan satu isian per hari berlaku');

  const k2 = (await mk('mgr', 'Pompa Air', 'daily', 'per_subject', 'Pompa', ['Pompa 1', 'Pompa 2', 'Pompa 3'], [
    { section: 'Unit', label: 'Suara normal', kind: 'check_na', scope: 'subject' },
    { section: 'Unit', label: 'Tekanan', kind: 'number', unit: 'bar', scope: 'subject' },
    { section: 'Umum', label: 'Ruang pompa bersih', kind: 'check', scope: 'run' },
  ]))[0].k;
  ok((await db.query('select count(*)::int c from routine_subjects s join routine_templates t on t.id=s.template_id where t.key=$1', [k2])).rows[0].c === 3, 'tiga objek tersimpan');
  ok((await db.query('select subject_noun from routine_templates where key=$1', [k2])).rows[0].subject_noun === 'pompa', 'sebutan objek disimpan huruf kecil');
  const subs2 = (await db.query('select s.id from routine_subjects s join routine_templates t on t.id=s.template_id where t.key=$1 order by s.sort', [k2])).rows.map(r => r.id);
  const only1 = await answers(k2, () => null, (it, sid) => sid !== null && sid !== subs2[0]);
  ok(!(await err('spv', 'select submit_routine_run($1,$2,$3)', [k2, J(only1), J(await files('spv', k2))])), 'objek rutinitas baru dikirim satu per satu');
  const only2 = await answers(k2, () => null, (it, sid) => sid !== null && sid !== subs2[1]);
  ok(!(await err('stf', 'select submit_routine_run($1,$2,$3)', [k2, J(only2), J(await files('stf', k2))])), 'rekan lain mengirim objek berbeda');
  ok((await err('mme', 'select submit_routine_run($1,$2,$3)', [k2, J(only1), J(await files('mme', k2))]) || '').includes('Sudah diperiksa'), 'objek yang sama tidak bisa dikirim dua kali');

  ok((await err('stf', 'select deactivate_routine($1)', ['genset']) || '').includes('bawaan'), 'rutinitas bawaan tidak bisa dihapus');
  ok((await err('rstf', 'select deactivate_routine($1)', [k1]) || '').includes('Hanya tim ME'), 'akun luar tidak bisa menghapus');
  ok((await err('stf', 'select deactivate_routine($1)', [k1]) || '').includes('sudah punya isian'), 'yang sudah punya isian tidak bisa dihapus');
  const k3 = (await mk('stf', 'Uji Hapus', 'weekly', 'whole', 'objek', [], simple))[0].k;
  ok((await err('spv', 'select deactivate_routine($1)', [k3]) || '').includes('Hanya pembuatnya'), 'anggota lain bukan pembuat tidak bisa menghapus');
  ok(!(await err('stf', 'select deactivate_routine($1)', [k3])), 'pembuat bisa menghapus yang belum punya isian');
  ok((await db.query('select is_active from routine_templates where key=$1', [k3])).rows[0].is_active === false, 'rutinitas dinonaktifkan, bukan dihapus fisik');
  const k4 = (await mk('stf', 'Uji Hapus', 'weekly', 'whole', 'objek', [], simple))[0].k;
  ok(k4 === 'uji-hapus-2', 'nama yang pernah dihapus boleh dipakai lagi dengan kunci baru');
  ok((await db.query("select count(*)::int c from admin_log where action='deactivate_routine'")).rows[0].c === 1, 'penghapusan tercatat di log admin');
}

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
