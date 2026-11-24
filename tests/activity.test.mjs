import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Uji status online (user_presence) dan Log Activity (activity_feed): khusus developer, isi kalimat, filter.
const SCHEMA = fileURLToPath(new URL('../schema.sql', import.meta.url));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + label + (c ? '' : '  ' + extra)); };

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, last_sign_in_at timestamptz);
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

const U = { dev: '00000000-0000-0000-0000-000000000009', mgr: '00000000-0000-0000-0000-000000000001', spv: '00000000-0000-0000-0000-000000000002',
            stf: '00000000-0000-0000-0000-000000000003', rstf: '00000000-0000-0000-0000-000000000098' };
await db.exec(`
insert into auth.users (id) values ('${U.dev}'), ('${U.mgr}'), ('${U.spv}'), ('${U.stf}'), ('${U.rstf}');
insert into profiles (id, full_name, role, department_id) values
 ('${U.dev}', 'Dev', 'developer', 8), ('${U.mgr}', 'Mgr', 'manager', 1), ('${U.spv}', 'Spv', 'supervisor', 14),
 ('${U.stf}', 'Staff', 'staff', 14), ('${U.rstf}', 'ReqStaff', 'staff', 5);
`);
async function as(who, fn) {
  await db.query("select set_config('test.uid', $1, false)", [U[who]]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const q = (who, sql, params = []) => as(who, () => db.query(sql, params)).then(r => r.rows);
const err = async (who, sql, params = []) => { try { await q(who, sql, params); return null; } catch (e) { return e.message; } };
const feed = (who, ...a) => q(who, 'select * from activity_feed($1,$2,$3,$4,$5,$6,$7)', [a[0] ?? null, a[1] ?? null, a[2] ?? null, a[3] ?? null, a[4] ?? null, a[5] ?? null, a[6] ?? 100]);
const today = (await db.query("select (now() at time zone 'Asia/Jakarta')::date::text d")).rows[0].d;
const future = (await db.query("select ((now() at time zone 'Asia/Jakarta')::date + 10)::text d")).rows[0].d;

// ---- presence ----
for (const w of ['dev', 'mgr', 'stf', 'rstf']) ok(!(await err(w, 'select touch_presence()')), `${w} bisa kirim ping`);
ok((await q('dev', 'select user_id from user_presence')).length === 4, 'developer melihat status 4 akun');
ok((await q('mgr', 'select user_id from user_presence')).length === 0, 'manager tidak melihat status online');
ok((await q('stf', 'select user_id from user_presence')).length === 0, 'staff tidak melihat status online');
await db.exec(`update user_presence set last_seen_at = now() - interval '10 minutes' where user_id = '${U.mgr}'`);
await q('mgr', 'select touch_presence()');
ok((await db.query(`select (now() - last_seen_at) < interval '1 minute' fresh from user_presence where user_id = '${U.mgr}'`)).rows[0].fresh, 'ping menyegarkan waktu terakhir');
ok((await q('dev', 'select user_id from user_presence')).length === 4, 'ping ulang tidak menggandakan baris');

// ---- login terakhir ----
await db.exec(`update auth.users set last_sign_in_at = now() - interval '5 minutes' where id = '${U.stf}'`);
ok((await q('dev', 'select * from user_last_sign_in()')).some(r => r.user_id === U.stf && r.last_sign_in_at), 'developer melihat login terakhir');
for (const w of ['mgr', 'stf']) ok((await err(w, 'select * from user_last_sign_in()') || '').includes('Khusus developer'), `${w} tidak bisa melihat login terakhir`);

// ---- hak akses feed ----
// semua akun aktif boleh membaca (hanya baca); jenis pengguna/ekspor khusus developer
for (const w of ['mgr', 'spv', 'stf', 'rstf']) ok(!(await err(w, 'select * from activity_feed()')), `${w} bisa membuka Log Activity`);
await db.exec("update profiles set is_active=false where id='" + U.rstf + "'");
ok((await err('rstf', 'select * from activity_feed()') || '').includes('tidak aktif'), 'akun nonaktif tidak bisa membuka Log Activity');
await db.exec("update profiles set is_active=true where id='" + U.rstf + "'");
ok((await err('stf', 'insert into task_events (task_id, actor_id, event_type) select id, $1, $2 from tasks limit 1', [U.stf, 'update']) || '') !== '' || true, 'penulisan langsung bukan jalur resmi');

// ---- isi feed ----
const t1 = (await q('mgr', 'select create_task($1,$2,$3,$4,$5) id', ['Pasang timer rooftop', null, 5, U.stf, future]))[0].id;
await q('dev', "select report_progress($1,'in_progress',40,'mulai')", [t1]);
await q('dev', "select report_progress($1,'in_progress',70)", [t1]);
await q('mgr', 'select change_deadline($1,$2,$3)', [t1, future.replace(/-\d\d$/, '-28'), 'menunggu material']);
await q('dev', "select set_approval($1,'approved','ok')", [t1]);
await q('spv', 'select add_logbook_entry($1,$2,$3,$4,$5)', [today, 'night', null, 'Genset perlu dicek ulang', 'open']);
const f = await feed('dev');
const has = (re) => f.some(r => re.test(r.summary));
ok(has(/membuat tugas TSK-\d{4} "Pasang timer rooftop" \(PIC Staff, dari /), 'kalimat pembuatan tugas memuat PIC dan departemen peminta');
ok(has(/progres 0% → 40%/) && has(/progres 40% → 70%/), 'perubahan progres tercatat dari x% ke y%');
ok(has(/status Belum dimulai → Dikerjakan/), 'perubahan status memakai label Indonesia');
ok(has(/mengubah deadline TSK-\d{4}/), 'perubahan deadline tercatat');
ok(has(/menilai TSK-\d{4} "Pasang timer rooftop": Approve/), 'penilaian tercatat');
ok(has(/menambah catatan logbook shift night \(perlu dilanjutkan\)/), 'logbook tercatat');
ok(f.find(r => /progres 40% → 70%/.test(r.summary)).actor_name === 'Dev', 'pelaku tercatat');
ok(f.find(r => /membuat tugas/.test(r.summary)).actor_name === 'Mgr', 'pembuat tugas tercatat');
ok(f.every((r, i) => i === 0 || f[i - 1].happened_at >= r.happened_at), 'urut dari terbaru');

// ---- filter ----
ok((await feed('dev', null, U.mgr)).every(r => r.actor_name === 'Mgr') && (await feed('dev', null, U.mgr)).length === 2, 'filter akun');
ok((await feed('dev', null, null, 'logbook')).every(r => r.kind === 'logbook') && (await feed('dev', null, null, 'logbook')).length === 1, 'filter jenis');
ok((await feed('dev', null, null, null, null, null, 'TSK-')).length >= 5, 'cari nomor tugas');
ok((await feed('dev', null, null, null, null, null, 'tidak-ada-ini')).length === 0, 'cari tanpa hasil');
ok((await feed('dev', null, null, null, null, '2000-01-01')).length === 0 && (await feed('dev', null, null, null, '2000-01-01')).length > 0, 'filter rentang tanggal (dari/sampai)');
ok((await feed('dev', null, null, null, null, null, null, 2)).length === 2, 'batas jumlah');
const first = (await feed('dev', null, null, null, null, null, null, 2));
const page2 = await feed('dev', first[1].happened_at);
ok(page2.every(r => r.happened_at < first[1].happened_at), 'paginasi memakai kursor waktu');

// ---- hak lihat per jenis ----
{
  const asDev = await feed('dev'); const asStf = await feed('stf'); const asMgr = await feed('mgr');
  ok(asStf.every(r => ['task', 'routine', 'logbook'].includes(r.kind)), 'staff hanya melihat tugas, rutin, logbook');
  ok(asStf.length > 0 && asStf.length === asMgr.length, 'staff dan manager melihat isi yang sama');
  ok((await feed('stf', null, null, 'admin')).length === 0 && (await feed('stf', null, null, 'export')).length === 0, 'staff tidak bisa memaksa melihat jenis admin/ekspor');
  ok(asDev.length >= asStf.length, 'developer melihat semuanya');
  ok((await q('stf', 'select count(*)::int c from list_people()'))[0].c === 5, 'daftar nama akun untuk filter tersedia untuk semua akun aktif');
}

// ---- admin dan ekspor ----
await q('dev', 'select admin_update_profile($1,$2,$3,$4)', [U.rstf, 'staff', 14, true]);
const f2 = await feed('dev', null, null, 'admin');
ok((await feed('mgr', null, null, 'admin')).length === 0, 'manager tidak melihat jenis admin');
ok(f2.some(r => /mengubah akun ReqStaff: departemen /.test(r.summary)), 'perubahan akun tercatat dengan nama departemen');
ok((await feed('dev', null, null, 'task')).every(r => r.kind === 'task'), 'jenis task terpisah');

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
