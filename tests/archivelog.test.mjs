import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Uji pencatatan ke Sheet/Drive di luar tugas dan rutin: bentuk baris, antrean database, fungsi baca, masa simpan foto.
const SCHEMA = fileURLToPath(new URL('../schema.sql', import.meta.url));
const fmt = await import(new URL('../supabase/functions/archive-log/format.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + label + (c ? '' : '  ' + JSON.stringify(extra))); };

// =============== bentuk baris (murni) ===============
const lb = { id: 7, entry_date: '2026-11-17', shift: 'night', entry_time: '23:30:00', body: 'Genset dicek', status: 'open', created_at: '2026-11-17T16:30:00Z', updated_at: '2026-11-17T17:00:00Z', revisions: 2, closed_at: null,
  creator: { full_name: 'Cici' }, updater: { full_name: 'Dedi' }, closer: null };
const r1 = fmt.logbookRow(lb);
ok(r1.length === fmt.TABS.logbook.headers.length, 'baris logbook selebar header', r1.length);
ok(r1[0] === 7 && r1[2] === 'Night' && r1[3] === '23:30' && r1[5] === 'Perlu dilanjutkan' && r1[6] === 'Cici' && r1[8] === 'Dedi' && r1[11] === '', 'isi baris logbook');
ok(r1[7] === '2026-11-17 23:30:00' && r1[9] === '2026-11-18 00:00:00', 'waktu logbook dalam WIB', [r1[7], r1[9]]);
ok(fmt.logbookRow({ ...lb, status: 'done', closed_at: '2026-11-18T01:00:00Z', closer: { full_name: 'Budi' } })[5] === 'Selesai', 'status selesai');

const ev = { id: 12, at: '2026-11-15T09:31:35Z', task_no: 3, title: 'Cat tangga', actor: 'Budi', kind: 'Update', change: 'progres 0% ke 25%', note: null };
const er = fmt.eventRow(ev);
ok(er.length === fmt.TABS.events.headers.length && er[2] === 'TSK-0003' && er[1] === '2026-11-15 16:31:35' && er[7] === '', 'baris riwayat tugas');

const run = { id: 'run-1', period: '2026-11-17', submitted_at: '2026-11-17T01:08:00Z', template: { name: 'Genset' }, inspector: 'Cici' };
const ans = [
  { run_id: 'run-1', item_id: 1, subject_id: 10, status: 'ok', num: 1234.5, note: null, item: { label: 'Hourmeter', section: 'Unit genset', kind: 'number', unit: 'jam' }, subject: { label: 'Genset 1' } },
  { run_id: 'run-1', item_id: 2, subject_id: 10, status: 'ok', num: null, note: null, item: { label: 'Bodi', section: 'Unit genset', kind: 'check', unit: null }, subject: { label: 'Genset 1' } },
  { run_id: 'run-1', item_id: 3, subject_id: 10, status: 'ng', num: null, note: 'oli rembes', item: { label: 'Level oli', section: 'Unit genset', kind: 'check', unit: null }, subject: { label: 'Genset 1' } },
  { run_id: 'run-1', item_id: 4, subject_id: null, status: 'na', num: null, note: null, item: { label: 'Tegangan antar-fasa | R-S', section: 'C', kind: 'number', unit: 'V' }, subject: null },
  { run_id: 'run-1', item_id: 5, subject_id: 10, status: 'na', num: null, note: null, item: { label: 'APAR', section: 'A', kind: 'check_na', unit: null }, subject: { label: 'Genset 1' } },
];
const dr = fmt.detailRows(run, ans);
ok(dr.length === 3, 'hanya angka dan temuan NG yang dicatat (OK/NA biasa dilewati)', dr.length);
ok(dr[0][0] === 'run-1|1|10' && dr[0][5] === 'Genset 1' && dr[0][8] === 'OK' && dr[0][9] === 1234.5 && dr[0][10] === 'jam', 'angka pengukuran lengkap dengan satuan');
ok(dr[1][8] === 'NG' && dr[1][11] === 'oli rembes' && dr[1][10] === '', 'temuan NG dengan catatan');
ok(dr[2][0] === 'run-1|4|0' && dr[2][8] === 'N/A' && dr[2][7] === 'Tegangan antar-fasa R-S', 'angka N/A dicatat, pemisah butir dirapikan');
ok(dr.every((r) => r.length === fmt.TABS.detail.headers.length), 'baris pengukuran selebar header');

const ph = { id: 'abcd1234-0000-0000-0000-000000000000', created_at: '2026-11-15T09:31:00Z', storage_path: 'tid/foto-1.JPG', task: { task_no: 12, title: 'Lampu store' }, uploader: { full_name: 'Cici' } };
ok(fmt.photoName(ph) === 'TSK-0012_2026-11-15_1631_abcd1234.jpg', 'nama berkas foto', fmt.photoName(ph));
ok(fmt.photoFolder(ph).join('/') === 'Foto Tugas/TSK-0012', 'folder foto per tugas');
const pr = fmt.photoRow(ph, 'https://drive.google.com/file/d/abc/view?usp=drivesdk', 'javascript:alert(1)');
ok(pr.length === fmt.TABS.photos.headers.length && pr[5].startsWith('https://drive.google.com/') && pr[6] === '', 'hanya tautan Drive resmi yang masuk ke Sheet');

const plan = fmt.planUpsert([['ID'], ['7'], [12]], [[7, 'baru'], [12, 'baru2'], [99, 'tambah']], 'Logbook', 13);
ok(plan.updates.length === 2 && plan.updates[0].range === "'Logbook'!A2:M2" && plan.updates[1].range === "'Logbook'!A3:M3" && plan.appends.length === 1 && plan.appends[0][0] === 99, 'rencana ubah/tambah berdasarkan ID di kolom A', plan);
ok(fmt.planUpsert([['ID']], [[1]], "Tab'x", 30).updates.length === 0, 'tab kosong: semua ditambah');
ok(fmt.planUpsert([['ID']], [], 'T', 30).appends.length === 0, 'tanpa baris: tidak ada tulis');

// =============== antrean dan fungsi database ===============
const db = new PGlite();
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

const U = { mgr: '00000000-0000-0000-0000-000000000001', stf: '00000000-0000-0000-0000-000000000003', dev: '00000000-0000-0000-0000-000000000009' };
await db.exec(`
insert into auth.users (id) values ('${U.mgr}'), ('${U.stf}'), ('${U.dev}');
insert into profiles (id, full_name, role, department_id) values ('${U.mgr}', 'Mgr', 'manager', 1), ('${U.stf}', 'Cici', 'staff', 14), ('${U.dev}', 'Dev', 'developer', 8);
`);
async function as(who, fn) {
  await db.query("select set_config('test.uid', $1, false)", [U[who]]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const q = (who, sql, params = []) => as(who, () => db.query(sql, params)).then((r) => r.rows);
const err = async (who, sql, params = []) => { try { await q(who, sql, params); return null; } catch (e) { return e.message; } };
const queue = async (kind) => (await db.query('select ref, queued_at from sheet_export_queue where kind=$1 order by ref', [kind])).rows;
const today = (await db.query("select (now() at time zone 'Asia/Jakarta')::date::text d")).rows[0].d;
const future = (await db.query("select ((now() at time zone 'Asia/Jakarta')::date + 20)::text d")).rows[0].d;

// logbook: tambah lalu ubah = satu antrean, waktu antrean maju
const lid = (await q('stf', 'select add_logbook_entry($1,$2,$3,$4,$5) id', [today, 'morning', '08:00', 'Cek pompa', 'open']))[0].id;
const l1 = await queue('logbook');
ok(l1.length === 1 && l1[0].ref === String(lid), 'catatan logbook baru masuk antrean');
await q('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [lid, '08:00', 'Cek pompa: oke', 'done']);
const l2 = await queue('logbook');
ok(l2.length === 1 && new Date(l2[0].queued_at) >= new Date(l1[0].queued_at), 'perubahan catatan memakai antrean yang sama (tidak ganda)');

// tugas: setiap kejadian masuk antrean
const tid = (await q('mgr', 'select create_task($1,$2,$3,$4,$5) id', ['Cat tangga', null, 5, U.stf, future]))[0].id;
await q('dev', "select report_progress($1,'in_progress',40,'mulai')", [tid]);
await q('mgr', 'select change_deadline($1,$2,$3)', [tid, today, 'dipercepat']);
await q('dev', "select set_approval($1,'approved','ok')", [tid]);
const evq = await queue('event');
ok(evq.length === 4, 'empat kejadian tugas masuk antrean', evq.length);
const rows = (await db.query('select * from sheet_event_rows($1)', [evq.map((x) => Number(x.ref))])).rows;
ok(rows.length === 4 && rows[0].kind === 'Dibuat' && rows[0].change.startsWith('PIC Cici, deadline '), 'kejadian dibuat memuat PIC dan deadline', rows[0]);
ok(rows[1].kind === 'Update' && rows[1].change === 'status Belum dimulai ke Dikerjakan, progres 0% ke 40%' && rows[1].note === 'mulai' && rows[1].actor === 'Dev', 'update memuat status dan progres dari/ke', rows[1]);
ok(rows[2].kind === 'Ubah deadline' && rows[2].change.endsWith(` ke ${today}`), 'perubahan deadline', rows[2]);
ok(rows[3].kind === 'Penilaian' && rows[3].change === 'Approve', 'penilaian', rows[3]);
ok(Number(rows[0].task_no) === 1 && rows[0].title === 'Cat tangga', 'nomor dan judul tugas ikut');
ok((await db.query('select count(*)::int c from sheet_event_rows($1)', [[999999]])).rows[0].c === 0, 'kejadian yang tidak ada (dihapus) tidak menghasilkan baris');

// isian rutin dan foto tugas
const tpl = (await db.query("select id from routine_templates where key='genset'")).rows[0].id;
const runId = (await db.query('insert into routine_runs (template_id, template_version, period, inspector_id) values ($1, 1, $2, $3) returning id', [tpl, today, U.stf])).rows[0].id;
ok((await queue('detail')).map((x) => x.ref).includes(runId), 'isian rutin baru masuk antrean pengukuran');
const att = (await db.query("insert into attachments (task_id, storage_path, uploaded_by) values ($1, $2, $3) returning id", [tid, `${tid}/a.jpg`, U.stf])).rows[0].id;
ok((await queue('photo')).map((x) => x.ref).includes(att), 'foto tugas baru masuk antrean');

// ack: hanya yang tidak berubah sejak dibaca
const before = await queue('logbook');
await db.exec("select pg_sleep(0.05)");
await q('stf', 'select edit_logbook_entry($1,$2,$3,$4)', [lid, '08:00', 'Cek pompa: oke dan bersih', 'done']);
await db.query('select ack_export_queue($1, $2, $3)', ['logbook', [String(lid)], [before[0].queued_at]]);
ok((await queue('logbook')).length === 1, 'perubahan yang datang saat diproses tetap antre');
const now2 = await queue('logbook');
await db.query('select ack_export_queue($1, $2, $3)', ['logbook', [String(lid)], [now2[0].queued_at]]);
ok((await queue('logbook')).length === 0, 'yang sudah diproses keluar dari antrean');
await db.query('select ack_export_queue($1, $2, $3)', ['event', evq.map((x) => x.ref), evq.map((x) => x.queued_at)]);
ok((await queue('event')).length === 0, 'ack banyak sekaligus');

// hak akses: hanya service role
for (const who of ['mgr', 'stf', 'dev']) {
  ok((await err(who, 'select * from sheet_export_queue') || '').includes('permission denied'), `${who} tidak bisa membaca antrean`);
  ok((await err(who, "select ack_export_queue('logbook', array['1'], array[now()])") || '').includes('permission denied'), `${who} tidak bisa memakai ack`);
  ok((await err(who, 'select * from sheet_event_rows(array[1]::bigint[])') || '').includes('permission denied'), `${who} tidak bisa membaca fungsi riwayat`);
}

// masa simpan foto: hanya setelah tersalin ke Drive (atau 7 hari tambahan)
await db.exec("update app_settings set value='3'::jsonb where key='photo_retention_days'");
const expired = async () => (await db.query('select id from attachments_expired')).rows.map((r) => r.id);
await db.exec(`update attachments set created_at = now() - interval '4 days' where id = '${att}'`);
ok(!(await expired()).includes(att), 'lewat masa simpan tetapi belum tersalin ke Drive: belum dihapus');
await db.exec(`update attachments set drive_url = 'https://drive.google.com/file/d/x/view' where id = '${att}'`);
ok((await expired()).includes(att), 'sudah tersalin ke Drive dan lewat masa simpan: boleh dihapus');
await db.exec(`update attachments set drive_url = null, created_at = now() - interval '11 days' where id = '${att}'`);
ok((await expired()).includes(att), 'arsip gagal terus: dihapus juga setelah 7 hari tambahan (penyimpanan tidak membengkak)');
await db.exec(`update attachments set created_at = now() - interval '1 day', drive_url = 'https://drive.google.com/file/d/x/view' where id = '${att}'`);
ok(!(await expired()).includes(att), 'foto baru tidak dihapus');

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
