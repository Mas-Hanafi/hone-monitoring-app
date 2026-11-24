import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Uji logbook shift ME: hak akses, validasi, revisi, kunci 7 hari.
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

// stf/stf2 = staff ME (dept 14). mgr = manager di luar ME (hanya melihat). rstf = staff departemen lain.
const U = { mgr: '00000000-0000-0000-0000-000000000001', stf: '00000000-0000-0000-0000-000000000003',
            stf2: '00000000-0000-0000-0000-000000000004', stf3: '00000000-0000-0000-0000-000000000005', rstf: '00000000-0000-0000-0000-000000000098' };
await db.exec(`
insert into auth.users (id) values ('${U.mgr}'), ('${U.stf}'), ('${U.stf2}'), ('${U.stf3}'), ('${U.rstf}');
insert into profiles (id, full_name, role, department_id) values
 ('${U.mgr}', 'Mgr', 'manager', 1), ('${U.stf}', 'Staff4', 'staff', 14), ('${U.stf2}', 'Staff5', 'staff', 14), ('${U.stf3}', 'Staff6', 'staff', 14), ('${U.rstf}', 'ReqStaff', 'staff', 5);
`);
async function as(who, fn) {
  await db.query("select set_config('test.uid', $1, false)", [U[who]]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const q = (who, sql, params = []) => as(who, () => db.query(sql, params)).then(r => r.rows);
const err = async (who, sql, params = []) => { try { await q(who, sql, params); return null; } catch (e) { return e.message; } };
const today = (await db.query("select (now() at time zone 'Asia/Jakarta')::date::text d")).rows[0].d;
const add = (who, date, shift, time, body, status = 'done') => q(who, 'select add_logbook_entry($1,$2,$3,$4,$5) id', [date, shift, time, body, status]);

// ---- tambah ----
const id1 = (await add('stf', today, 'morning', '08:30', 'Cek genset, semua normal'))[0].id;
ok(!!id1, 'staff ME bisa menambah catatan');
for (const s of ['evening', 'night']) ok(!(await err('stf2', 'select add_logbook_entry($1,$2,$3,$4)', [today, s, null, `Catatan ${s}`])), `shift ${s} bisa diisi (tanpa jam)`);
ok((await err('stf', 'select add_logbook_entry($1,$2,$3,$4)', [today, 'afternoon', null, 'x']) || '').includes('Shift tidak dikenal'), 'shift di luar morning/evening/night ditolak');
ok((await err('stf', 'select add_logbook_entry($1,$2,$3,$4)', [today, 'morning', null, '   ']) || '').includes('1 sampai 2000'), 'isi kosong ditolak');
ok((await err('stf', 'select add_logbook_entry($1,$2,$3,$4)', [today, 'morning', null, 'x'.repeat(2001)]) || '').includes('1 sampai 2000'), 'isi lebih dari 2000 karakter ditolak');
ok((await err('stf', 'select add_logbook_entry($1,$2,$3,$4)', ['2020-01-01', 'morning', null, 'lama']) || '').includes('7 hari'), 'tanggal terlalu lampau ditolak');
ok((await err('stf', 'select add_logbook_entry($1,$2,$3,$4)', ['2099-01-01', 'morning', null, 'depan']) || '').includes('7 hari'), 'tanggal terlalu jauh ke depan ditolak');
ok((await err('mgr', 'select add_logbook_entry($1,$2,$3,$4)', [today, 'morning', null, 'x']) || '').includes('Hanya tim ME'), 'manager di luar ME tidak bisa menambah');
ok((await err('rstf', 'select add_logbook_entry($1,$2,$3,$4)', [today, 'morning', null, 'x']) || '').includes('Hanya tim ME'), 'staff departemen lain tidak bisa menambah');
ok((await err('stf', 'insert into logbook_entries (entry_date, shift, body, created_by) values (current_date, $1, $2, $3)', ['morning', 'langsung', U.stf]) || '').includes('permission denied'), 'insert langsung ditolak');

// ---- baca ----
ok((await q('stf2', 'select id from logbook_entries')).length === 3, 'staff ME melihat semua catatan tim');
ok((await q('mgr', 'select id from logbook_entries')).length === 3, 'manager di luar ME bisa membaca');
ok((await q('rstf', 'select id from logbook_entries')).length === 0, 'staff departemen lain tidak melihat logbook');

// ---- ubah oleh anggota lain, dengan revisi ----
await q('stf2', 'select edit_logbook_entry($1,$2,$3,$4)', [id1, '08:45', 'Cek genset, semua normal. Solar ditambah 20 L', 'done']);
const e1 = (await q('stf', 'select body, entry_time::text t, created_by, updated_by, revisions from logbook_entries where id=$1', [id1]))[0];
ok(e1.body.includes('Solar ditambah') && e1.t.startsWith('08:45') && e1.created_by === U.stf && e1.updated_by === U.stf2 && e1.revisions === 1, 'anggota ME lain bisa mengubah; pencatat awal dan pengubah tercatat');
const rev = (await q('stf', 'select body, edited_by from logbook_revisions where entry_id=$1', [id1]));
ok(rev.length === 1 && rev[0].body === 'Cek genset, semua normal' && rev[0].edited_by === U.stf2, 'isi lama tersimpan sebagai revisi');
await q('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [id1, '08:45', 'Cek genset, semua normal. Solar ditambah 20 L', 'done']);
ok((await q('stf', 'select revisions from logbook_entries where id=$1', [id1]))[0].revisions === 1, 'tanpa perubahan: tidak membuat revisi baru');
ok((await err('mgr', 'select edit_logbook_entry($1,$2,$3,$4)', [id1, null, 'ubah', 'done']) || '').includes('Hanya tim ME'), 'manager di luar ME tidak bisa mengubah');
ok((await err('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [id1, null, '', 'done']) || '').includes('1 sampai 2000'), 'ubah menjadi kosong ditolak');
ok((await err('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [999999, null, 'x', 'done']) || '').includes('tidak ditemukan'), 'catatan tidak ada ditolak');
ok((await q('mgr', 'select count(*)::int c from logbook_revisions'))[0].c === 1 && (await q('rstf', 'select count(*)::int c from logbook_revisions'))[0].c === 0, 'revisi terbaca pimpinan, tidak oleh departemen lain');
ok((await err('stf', "update logbook_revisions set body='x'") || '').includes('permission denied'), 'revisi tidak bisa diubah langsung');
ok(((await db.query("update logbook_revisions set body='x'").catch(e => e.message)) + '').includes('append-only'), 'revisi append-only di tingkat trigger');

// ---- handover: pekerjaan open dilanjutkan shift berikutnya ----
const hid = (await q('stf', 'select add_logbook_entry($1,$2,$3,$4,$5) id', [today, 'morning', '10:00', 'Pompa air lantai 2 belum selesai diganti seal', 'open']))[0].id;
ok((await q('stf', 'select status, closed_by from logbook_entries where id=$1', [hid]))[0].status === 'open', 'catatan bisa ditandai "perlu dilanjutkan" (open)');
const hn = (await db.query("select user_id, title, body from notifications where type='logbook'")).rows;
ok(hn.length === 2 && !hn.some(r => r.user_id === U.stf) && [U.stf2, U.stf3].every(u => hn.some(r => r.user_id === u)) && !hn.some(r => r.user_id === U.mgr || r.user_id === U.rstf), 'handover open: anggota ME lain dikabari, pengisi dan non-ME tidak');
ok(hn[0].body.includes('Pompa air') && hn[0].body.includes('morning'), 'notifikasi memuat isi dan shift');
ok((await err('stf', 'select add_logbook_entry($1,$2,$3,$4,$5)', [today, 'morning', null, 'x', 'selesai']) || '').includes('Status tidak dikenal'), 'status tidak dikenal ditolak');
ok(!(await db.query("select 1 from notifications where type='logbook' and user_id=$1", [U.stf]).then(r => r.rows.length)), 'pembuat tidak mendapat notifikasi handover sendiri');
const n0 = (await db.query("select count(*)::int c from notifications where type='logbook'")).rows[0].c;
await add('stf2', today, 'evening', null, 'Catatan biasa tanpa handover');
ok((await db.query("select count(*)::int c from notifications where type='logbook'")).rows[0].c === n0, 'catatan biasa (done) tidak memicu notifikasi');
// shift berikutnya menyelesaikan, penyelesai tercatat
await q('stf3', 'select edit_logbook_entry($1,$2,$3,$4)', [hid, '10:00', 'Pompa air lantai 2: seal sudah diganti, tes tekanan OK', 'done']);
const hc = (await q('stf', 'select status, created_by, updated_by, closed_by, closed_at is not null as has_closed_at, revisions from logbook_entries where id=$1', [hid]))[0];
ok(hc.status === 'done' && hc.created_by === U.stf && hc.updated_by === U.stf3 && hc.closed_by === U.stf3 && hc.has_closed_at && hc.revisions === 1, 'penyelesai (closed_by), pembuat, dan pengubah tercatat terpisah');
const hr = (await q('stf', 'select status, body from logbook_revisions where entry_id=$1', [hid]))[0];
ok(hr.status === 'open' && hr.body.includes('belum selesai'), 'revisi menyimpan status dan isi sebelum diubah');
// dibuka lagi: closed_by dikosongkan
await q('stf2', 'select edit_logbook_entry($1,$2,$3,$4)', [hid, '10:00', 'Pompa air lantai 2: bocor lagi, perlu cek ulang', 'open']);
const hreo = (await q('stf', 'select status, closed_by, updated_by, revisions from logbook_entries where id=$1', [hid]))[0];
ok(hreo.status === 'open' && hreo.closed_by === null && hreo.updated_by === U.stf2 && hreo.revisions === 2, 'dibuka lagi: closed_by dikosongkan, pengubah terakhir tercatat');
// ubah isi saat tetap done tidak mengubah penyelesai
await q('stf3', 'select edit_logbook_entry($1,$2,$3,$4)', [hid, '10:00', 'Pompa air lantai 2: seal diganti ulang', 'done']);
await q('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [hid, '10:00', 'Pompa air lantai 2: seal diganti ulang (rapi)', 'done']);
const hc2 = (await q('stf', 'select closed_by from logbook_entries where id=$1', [hid]))[0];
ok(hc2.closed_by === U.stf3, 'mengedit catatan yang sudah done tidak menimpa penyelesai');
// open lama tetap bisa diselesaikan walau lewat 7 hari; done lama terkunci
const oid = (await q('stf', 'select add_logbook_entry($1,$2,$3,$4,$5) id', [today, 'night', null, 'Kabel ATS perlu dirapikan', 'open']))[0].id;
await db.query("update logbook_entries set entry_date = (now() at time zone 'Asia/Jakarta')::date - 10 where id=$1", [oid]);
ok(!(await err('stf2', 'select edit_logbook_entry($1,$2,$3,$4)', [oid, null, 'Kabel ATS sudah dirapikan', 'done'])), 'pekerjaan open yang sudah lewat 7 hari masih bisa diselesaikan');
ok((await err('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [oid, null, 'ubah lagi', 'done']) || '').includes('terkunci'), 'setelah selesai dan lewat 7 hari, terkunci');
await add('stf2', today, 'evening', '20:00', 'Lampu taman sisi barat menunggu part', 'open');
ok((await q('mgr', "select count(*)::int c from logbook_entries where status='open'"))[0].c === 1, 'pimpinan melihat daftar pekerjaan open');

// ---- kunci 7 hari ----
await db.query("update logbook_entries set entry_date = (now() at time zone 'Asia/Jakarta')::date - 8 where id=$1", [id1]);
ok((await err('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [id1, null, 'terlambat', 'done']) || '').includes('terkunci'), 'catatan lebih dari 7 hari terkunci');

// ---- kunci optimistis: dua orang mengubah catatan yang sama ----
{
  const cid = (await add('stf', today, 'morning', '09:00', 'Cek panel', 'done'))[0].id;
  const rev0 = (await q('stf', 'select revisions from logbook_entries where id=$1', [cid]))[0].revisions;
  await q('stf2', 'select edit_logbook_entry($1,$2,$3,$4,$5)', [cid, '09:00', 'Cek panel: kabel longgar', 'done', rev0]);
  ok((await err('stf', 'select edit_logbook_entry($1,$2,$3,$4,$5)', [cid, '09:00', 'Cek panel (versi saya)', 'done', rev0]) || '').includes('diubah orang lain'), 'simpan atas versi usang ditolak, perubahan orang lain tidak tertimpa');
  ok((await q('stf', 'select body from logbook_entries where id=$1', [cid]))[0].body === 'Cek panel: kabel longgar', 'isi catatan tetap versi yang disimpan lebih dulu');
  const rev1 = (await q('stf', 'select revisions from logbook_entries where id=$1', [cid]))[0].revisions;
  ok(!(await err('stf', 'select edit_logbook_entry($1,$2,$3,$4,$5)', [cid, '09:00', 'Cek panel: kabel dikencangkan', 'done', rev1])), 'simpan atas versi terbaru berhasil');
  ok(!(await err('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [cid, '09:00', 'Tanpa pengecekan', 'done'])), 'tanpa parameter revisi tetap berjalan (kompatibel)');
}

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
