import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA = process.argv[2] ?? fileURLToPath(new URL('../schema.sql', import.meta.url));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + label + (c ? '' : '  ' + extra)); };

// ---- stub Supabase ----
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
-- tiru default privilege Supabase
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
`);

// ---- muat skema ----
try { await db.exec(readFileSync(SCHEMA, 'utf8')); ok(true, 'skema termuat tanpa error'); }
catch (e) { ok(false, 'skema termuat', e.message); process.exit(1); }

// App khusus tim ME (departemen 14): spv/stf/stf2 anggota ME (boleh jadi PIC).
// req = SPV departemen lain (5) yang hanya meminta tugas dan melihat beban kerja ME.
const U = { mgr: '00000000-0000-0000-0000-000000000001', spv: '00000000-0000-0000-0000-000000000002',
            stf: '00000000-0000-0000-0000-000000000003', stf2: '00000000-0000-0000-0000-000000000004',
            req: '00000000-0000-0000-0000-000000000099' };
await db.exec(`
insert into auth.users (id) values ('${U.mgr}'), ('${U.spv}'), ('${U.stf}'), ('${U.stf2}'), ('${U.req}');
insert into profiles (id, full_name, role, department_id) values
 ('${U.mgr}', 'Mgr', 'manager', 1), ('${U.spv}', 'Spv', 'supervisor', 14),
 ('${U.stf}', 'Staff4', 'staff', 14), ('${U.stf2}', 'Staff5', 'staff', 14),
 ('${U.req}', 'Req', 'supervisor', 5);
`);

async function as(who, fn) {
  await db.query("select set_config('test.uid', $1, false)", [U[who]]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function err(who, sql, params = []) {
  try { await as(who, () => db.query(sql, params)); return null; } catch (e) { return e.message; }
}
const q = (who, sql, params = []) => as(who, () => db.query(sql, params)).then(r => r.rows);
const future = '2099-01-01';

// ---- create_task ----
ok((await err('stf', 'select create_task($1,$2,$3,$4,$5)', ['x', null, 1, U.stf, future]) || '').includes('Hanya SPV'), 'staff tidak boleh buat tugas');
ok((await err('spv', 'select create_task($1,$2,$3,$4,$5)', ['x', null, 1, U.mgr, future]) || '').includes('tim ME'), 'PIC di luar tim ME ditolak (departemen lain hanya meminta)');
ok((await err('req', 'select create_task($1,$2,$3,$4,$5)', ['x', null, 5, U.req, future]) || '').includes('tim ME'), 'SPV departemen lain tidak bisa jadi PIC sendiri');
ok((await err('spv', 'select create_task($1,$2,$3,$4,$5)', ['x', null, 1, U.stf, '2020-01-01']) || '').includes('masa lalu'), 'deadline masa lalu ditolak');
ok(!!(await err('spv', 'select create_task($1,$2,$3,$4,$5)', ['x'.repeat(201), null, 1, U.stf, future])), 'judul > 200 ditolak');
const t1 = (await q('spv', 'select create_task($1,$2,$3,$4,$5) id', ['Tugas satu', null, 1, U.stf, future]))[0].id;
const t2 = (await q('mgr', 'select create_task($1,$2,$3,$4,$5) id', ['Tugas dua', null, 2, U.stf2, future]))[0].id;
const t3 = (await q('mgr', 'select create_task($1,$2,$3,$4,$5) id', ['Tugas tiga', null, 2, U.stf, future]))[0].id;

// ---- RLS ----
ok((await q('stf2', 'select id from tasks')).length === 3, 'staff ME melihat semua tugas tim (beban kerja ME)');
ok((await q('spv', 'select id from tasks')).length === 3, 'SPV tim ME lihat semua tugas ME (3)');
ok((await q('req', 'select id from tasks')).length === 3, 'SPV departemen lain juga lihat beban kerja ME (3)');
ok((await q('req', 'select id from profiles')).every(r => r.id === U.req || [U.spv, U.stf, U.stf2].includes(r.id)), 'SPV departemen lain melihat dirinya + tim ME saja');
ok((await q('mgr', 'select id from tasks')).length === 3, 'manager lihat semua');
ok((await err('stf', 'insert into tasks (title) values ($1)', ['hack']) || '').includes('permission denied'), 'insert langsung ke tasks ditolak');

// ---- report_progress ----
ok((await err('stf', 'select report_progress($1,$2,$3)', [t1, 'in_progress', 40]) || '').includes('Foto wajib'), 'ganti status tanpa foto ditolak (staff)');
await q('stf', 'select report_progress($1,$2,$3,$4,null,$5)', [t1, 'in_progress', 40, 'mulai', [`${t1}/a.jpg`]]);
ok((await err('stf', 'select report_progress($1,$2,$3)', [t1, 'in_progress', 20]) || '').includes('Catatan wajib'), 'progress turun tanpa catatan ditolak');
ok((await err('stf', 'select report_progress($1,$2)', [t1, 'cancelled']) || '').includes('Hanya SPV'), 'staff tidak boleh batalkan');
const cid = '11111111-1111-1111-1111-111111111111';
await q('stf', 'select report_progress($1,$2,$3,$4,null,$5,$6)', [t1, 'in_progress', 70, 'hampir', [], cid]);
await q('stf', 'select report_progress($1,$2,$3,$4,null,$5,$6)', [t1, 'in_progress', 70, 'hampir', [], cid]);
ok((await db.query("select count(*)::int c from task_events where client_id = $1", [cid])).rows[0].c === 1, 'retry dengan client_id tidak menggandakan event');
await q('stf', 'select report_progress($1,$2,$3,$4,null,$5)', [t1, 'done', null, 'beres', [`${t1}/b.jpg`]]);
const row1 = (await db.query('select status, progress, completed_at from tasks where id=$1', [t1])).rows[0];
ok(row1.status === 'done' && row1.progress === 100 && row1.completed_at, 'done => progress 100, completed_at terisi');

// manager batalkan tugas 2 tanpa p_progress
await q('mgr', 'select report_progress($1,$2,null,$3)', [t2, 'cancelled', 'batal']);
ok((await db.query('select progress, status from tasks where id=$1', [t2])).rows[0].status === 'cancelled', 'cancel tanpa p_progress berhasil');

// ---- append-only ----
ok((await db.query('select 1').then(() => db.query("update task_events set note='x'").catch(e => e.message))).includes?.('append-only'), 'task_events tidak bisa di-update');

// ---- backdate t1 untuk uji keadaan per tanggal ----
// created 28 Okt, in_progress 40 pada 29 Okt, 70 pada 3 Nov, done pada 5 Nov (WIB siang)
const ev = (await db.query('select id, event_type, new_values from task_events where task_id=$1 order by id', [t1])).rows;
const stamps = ['2026-10-28T03:00:00Z', '2026-10-29T03:00:00Z', '2026-11-03T03:00:00Z', '2026-11-05T03:00:00Z'];
ok(ev.length === 4, 'task t1 punya 4 event', String(ev.length));
await db.exec('alter table task_events disable trigger task_events_immutable');
for (let i = 0; i < ev.length; i++) await db.query('update task_events set created_at=$1 where id=$2', [stamps[i], ev[i].id]);
await db.exec('alter table task_events enable trigger task_events_immutable');
await db.query('update tasks set assigned_at=$1 where id=$2', [stamps[0], t1]);
// t3 diberi tanggal mendatang supaya tidak ikut periode lama
await db.query("update tasks set assigned_at = now() + interval '1 day' where id in ($1)", [t3]);

const today = (await db.query("select (now() at time zone 'Asia/Jakarta')::date d")).rows[0].d;
console.log('   (tanggal mesin:', new Date(today).toISOString().slice(0, 10), ')');

// minggu 26 Okt - 1 Nov: tugas masih in_progress 40
let r = await q('mgr', "select * from export_tasks('2026-10-26','2026-11-01') where title='Tugas satu'");
ok(r.length === 1 && r[0].status === 'in_progress' && r[0].progress_end === 40 && r[0].progress_start == null && r[0].completed_on == null,
   'export minggu lama = keadaan akhir minggu (in_progress 40), bukan keadaan sekarang', JSON.stringify(r));
// minggu 2 - 8 Nov: 40 -> 100, selesai 5 Nov
r = await q('mgr', "select * from export_tasks('2026-11-02','2026-11-08') where title='Tugas satu'");
ok(r.length === 1 && r[0].progress_start === 40 && r[0].progress_end === 100 && r[0].status === 'done' &&
   String(new Date(r[0].completed_on).toISOString()).startsWith('2026-11-05'),
   'export minggu berikut: 40 -> 100, selesai 5 Nov', JSON.stringify(r));
// tugas selesai sebelum periode tidak ikut
r = await q('mgr', "select * from export_tasks('2026-11-09','2026-11-15') where title='Tugas satu'");
ok(r.length === 0, 'tugas selesai sebelum periode tidak muncul');

// ---- close_month membekukan keadaan akhir bulan ----
if (today > new Date('2026-11-01')) {
  await q('mgr', "select close_month('2026-10')");
  const snap = (await db.query("select rows from monthly_snapshots where period='2026-10'")).rows[0].rows;
  const s1 = snap.find(x => x.title === 'Tugas satu');
  ok(s1 && s1.status === 'in_progress' && s1.progress_end === 40, 'snapshot Oktober memuat keadaan 31 Okt, bukan keadaan hari tutup', JSON.stringify(s1));
  ok((await err('mgr', "select close_month('2026-10')") || '').includes('sudah ditutup'), 'tutup bulan dua kali ditolak');
  ok(String(await db.query("update monthly_snapshots set rows='[]'").catch(e => e.message)).includes('append-only'), 'snapshot tidak bisa diubah');
} else console.log('SKIP close_month (mesin belum lewat 1 Nov 2026)');
ok((await err('mgr', "select close_month('2099-01')") || '').includes('belum berakhir'), 'bulan belum berakhir tidak bisa ditutup');
ok((await err('spv', "select close_month('2026-10')") || '').includes('Hanya Manager'), 'SPV tidak boleh tutup bulan');

// cancel tugas done: completed_at tetap
await q('mgr', 'select report_progress($1,$2,null,$3)', [t1, 'cancelled', 'dibatalkan']);
ok((await db.query('select completed_at from tasks where id=$1', [t1])).rows[0].completed_at != null, 'cancel tugas done tidak menghapus completed_at');

// ---- hak export + paging + log ----
ok((await err('stf', "select * from export_tasks('2026-01-01','2026-12-31')") || '').includes('Tidak berwenang'), 'staff tidak boleh export');
await db.query("update tasks set assigned_at = '2026-11-02T03:00:00Z' where id in ($1,$2)", [t2, t3]);
const spvRows = await q('spv', "select title from export_tasks('2026-10-01','2026-12-31')");
ok(spvRows.length === 3, 'export SPV tim ME mencakup semua tugas timnya', JSON.stringify(spvRows));
const all = await q('mgr', "select task_no, title from export_tasks('2026-10-01','2026-12-31')");
ok(all.length === 3, 'manager export 3 baris', JSON.stringify(all));
const p1 = await q('mgr', "select task_no from export_tasks('2026-10-01','2026-12-31', 0, 2)");
const p2 = await q('mgr', "select task_no from export_tasks('2026-10-01','2026-12-31', $1, 2)", [p1[p1.length - 1].task_no]);
ok(p1.length === 2 && p2.length === 1, 'paginasi: 2 + 1 baris', `${p1.length}+${p2.length}`);
ok(!!(await err('mgr', "select * from export_tasks('2026-10-01','2026-12-31', 0, 5000)")), 'p_limit > 1000 ditolak');
const logs = (await db.query('select sum(row_count)::int s, count(*)::int c from export_logs')).rows[0];
ok(logs.c >= 5 && logs.s > 0, 'setiap halaman export tercatat', JSON.stringify(logs));

ok(String(await db.query('delete from export_logs').catch(e => e.message)).includes('append-only'), 'export_logs tidak bisa dihapus');

// ---- storage ----
const b = (await db.query("select file_size_limit, allowed_mime_types from storage.buckets where id='task-photos'")).rows[0];
ok(b.file_size_limit === 1572864 && b.allowed_mime_types.includes('image/webp'), 'bucket punya batas ukuran dan tipe');
await db.query("insert into storage.objects (bucket_id, name, created_at) values ('task-photos', $1, now() - interval '3 days'), ('task-photos', $2, now() - interval '3 days')", [`${t1}/orphan.jpg`, `${t1}/a.jpg`]);
const orph = (await db.query('select storage_path from storage_orphans')).rows.map(x => x.storage_path);
ok(orph.length === 1 && orph[0] === `${t1}/orphan.jpg`, 'file tanpa baris attachments terdeteksi yatim', JSON.stringify(orph));
ok((await db.query('select count(*)::int c from attachments_expired')).rows[0].c === 0, 'foto baru belum kedaluwarsa');
await db.query("update attachments set created_at = now() - interval '8 days' where storage_path = $1", [`${t1}/a.jpg`]);
ok((await db.query('select count(*)::int c from attachments_expired')).rows[0].c === 0, 'foto lewat masa simpan tetapi belum tersalin ke Drive: belum masuk daftar hapus');
await db.query("update attachments set drive_url = 'https://drive.google.com/file/d/x/view' where storage_path = $1", [`${t1}/a.jpg`]);
ok((await db.query('select count(*)::int c from attachments_expired')).rows[0].c === 1, 'foto lewat masa simpan dan sudah tersalin ke Drive masuk daftar hapus');

// ---- hak akses ----
ok((await err('mgr', 'select * from task_state_asof(current_date)') || '').includes('permission denied'), 'task_state_asof tidak bisa dipanggil klien');
ok((await err('mgr', 'select * from export_rows(current_date, current_date, null)') || '').includes('permission denied'), 'export_rows tidak bisa dipanggil klien');
ok((await err('mgr', 'select * from storage_orphans') || '').includes('permission denied'), 'storage_orphans tidak terbaca klien');
ok((await err('mgr', 'select * from attachments_expired') || '').includes('permission denied'), 'attachments_expired tidak terbaca klien');
await db.exec('create table baru (x int); create function fbaru() returns int language sql as $$ select 1 $$;');
ok((await err('mgr', 'select * from baru') || '').includes('permission denied'), 'tabel baru tidak otomatis terbuka');
ok((await err('mgr', 'select fbaru()') || '').includes('permission denied'), 'fungsi baru tidak otomatis bisa dieksekusi');


// ---- antrean sinkron Google Sheet ----
const qs = (await db.query('select task_id, queued_at::text qa from sheet_outbox order by task_id')).rows;
ok(qs.length === 3, 'antrean berisi 1 baris per tugas (dedup), 3 tugas', String(qs.length));
const q1 = qs.find(r => r.task_id === t1);
await db.query('update tasks set title = title where id = $1', [t1]);
const q1b = (await db.query('select queued_at::text qa from sheet_outbox where task_id=$1', [t1])).rows[0].qa;
ok(q1b !== q1.qa, 'update ulang memperbarui queued_at', `${q1.qa} vs ${q1b}`);
const ackOld = (await db.query('select ack_sheet_outbox($1::uuid[], $2::timestamptz[]) n', [[t1], [q1.qa]])).rows[0].n;
ok(ackOld === 0 && (await db.query('select 1 from sheet_outbox where task_id=$1', [t1])).rows.length === 1,
   'ack dengan queued_at lama TIDAK menghapus tugas yang berubah lagi');
const ackNew = (await db.query('select ack_sheet_outbox($1::uuid[], $2::timestamptz[]) n', [[t1], [q1b]])).rows[0].n;
ok(ackNew === 1 && (await db.query('select 1 from sheet_outbox where task_id=$1', [t1])).rows.length === 0, 'ack dengan queued_at cocok menghapus');
ok((await err('mgr', 'select * from sheet_outbox') || '').includes('permission denied'), 'klien tidak bisa membaca sheet_outbox');
ok((await err('mgr', 'select ack_sheet_outbox($1::uuid[], $2::timestamptz[])', [[t1], [q1b]]) || '').includes('permission denied'), 'klien tidak bisa memanggil ack');
await q('spv', 'select create_task($1,$2,$3,$4,$5)', ['Tugas empat', null, 1, U.stf, future]);
ok((await db.query('select count(*)::int c from sheet_outbox')).rows[0].c === 3, 'tugas baru otomatis masuk antrean');


// ---- approval ----
const ap = async (id) => (await db.query('select approval, status, completed_at, latest_note from tasks where id=$1', [id])).rows[0];
ok((await err('stf', "select set_approval($1,'approved')", [t3]) || '').includes('Tidak berwenang'), 'staff tidak boleh menilai');
ok((await err('spv', "select set_approval($1,'pending')", [t3]) || '').includes('Pilih Approve'), 'Pending tidak bisa di-set manual');
ok((await err('spv', "select set_approval($1,'rejected')", [t3]) || '').includes('Catatan wajib'), 'Reject tanpa catatan ditolak');
ok((await err('req', "select set_approval($1,'approved')", [t2]) || '').includes('Tidak berwenang'), 'SPV departemen lain tidak boleh menilai tugas yang bukan permintaannya');
ok((await err('mgr', "select set_approval($1,'approved')", [t1]) || '').includes('dibatalkan'), 'tugas dibatalkan tidak bisa dinilai');
ok((await ap(t3)).approval === 'pending', 'tugas baru = Pending');

await q('stf', 'select report_progress($1,$2,null,$3,null,$4)', [t3, 'done', 'beres', [`${t3}/c.jpg`]]);
await q('spv', "select set_approval($1,'approved')", [t3]);
ok((await ap(t3)).approval === 'approved', 'SPV approve tugas departemennya');

await q('spv', "select set_approval($1,'rejected',$2)", [t3, 'cat belum rata']);
let a3 = await ap(t3);
ok(a3.approval === 'rejected' && a3.status === 'in_progress' && a3.completed_at === null && a3.latest_note === 'cat belum rata',
   'Reject: kembali ke Dikerjakan, completed_at kosong, catatan jadi keterangan terbaru', a3);

await q('stf', 'select report_progress($1,$2,null,$3,null,$4)', [t3, 'done', 'sudah diperbaiki', [`${t3}/d.jpg`]]);
ok((await ap(t3)).approval === 'pending', 'diajukan selesai ulang => Pending lagi');
await q('spv', "select set_approval($1,'approved')", [t3]);
ok((await db.query("select count(*)::int c from task_events where task_id=$1 and event_type='approval'", [t3])).rows[0].c === 3, 'setiap penilaian tercatat di log (3)');

// tidak boleh menilai tugas sendiri
const tSpv = (await q('mgr', 'select create_task($1,$2,$3,$4,$5) id', ['Tugas SPV', null, 1, U.spv, future]))[0].id;
ok(!(await err('spv', "select set_approval($1,'approved')", [tSpv])), 'SPV tim ME boleh menilai tugasnya sendiri (tidak menunggu departemen lain)');
ok((await ap(tSpv)).approval === 'approved', 'penilaian SPV ME atas tugasnya sendiri tersimpan');
ok((await db.query("select count(*)::int c from notifications where task_id=$1 and type='approval'", [tSpv])).rows[0].c === 0, 'menilai tugas sendiri tidak mengirim notifikasi ke diri sendiri');
ok((await db.query("select actor_id from task_events where task_id=$1 and event_type='approval'", [tSpv])).rows[0].actor_id === U.spv, 'log penilaian mencatat pelaku (SPV) walau PIC-nya sama');
await q('mgr', "select set_approval($1,'hold',$2)", [tSpv, 'tunggu anggaran']);
ok((await ap(tSpv)).approval === 'hold', 'Manager boleh menilai tugas SPV (Hold dengan catatan)');

// riwayat per tanggal: kemarin Pending/belum mulai, hari ini Approve/selesai
const wib = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
const todayS = wib(new Date()), yestS = wib(new Date(Date.now() - 864e5));
const rY = await q('mgr', "select * from export_tasks($1,$1) where title='Tugas tiga'", [yestS]);
ok(rY.length === 1 && rY[0].approval === 'Pending' && rY[0].status === 'not_started', 'export kemarin: Pending, Belum dimulai', rY);
const rT = await q('mgr', "select * from export_tasks($1,$1) where title='Tugas tiga'", [todayS]);
ok(rT.length === 1 && rT[0].approval === 'Approve' && rT[0].status === 'done' && rT[0].progress_end === 100, 'export hari ini: Approve, Selesai, 100%', rT);


// ---- manajemen pengguna ----
U.dev = '00000000-0000-0000-0000-000000000005';
await db.exec(`insert into auth.users (id) values ('${U.dev}');
  insert into profiles (id, full_name, role, department_id) values ('${U.dev}', 'Dev', 'developer', 8);`);
const upd = (who, id, role, dept, active) =>
  err(who, 'select admin_update_profile($1,$2,$3,$4)', [id, role, dept, active]);
ok((await upd('mgr', U.stf, 'staff', 4, true) || '').includes('Hanya Developer'), 'Manager tidak boleh mengubah pengguna');
ok((await upd('stf', U.stf, 'manager', 4, true) || '').includes('Hanya Developer'), 'staff tidak bisa menaikkan role sendiri');
ok((await upd('dev', U.stf, 'staff', 99, true) || '').includes('Departemen tidak valid'), 'departemen tidak valid ditolak');
ok((await upd('dev', U.dev, 'manager', 8, true) || '').includes('akun sendiri'), 'Developer tidak boleh menurunkan diri sendiri');
ok((await upd('dev', U.dev, 'developer', 8, false) || '').includes('akun sendiri'), 'Developer tidak boleh menonaktifkan diri sendiri');
ok(!(await upd('dev', U.stf, 'staff', 14, true)), 'Developer boleh memperbarui profil pengguna');
ok((await db.query("select count(*)::int c from admin_log where action='update_profile' and target_id=$1", [U.stf])).rows[0].c === 1, 'perubahan profil tercatat di admin_log');
const lg = (await db.query("select details from admin_log order by id desc limit 1")).rows[0].details;
ok(lg.old.role === 'staff' && lg.new.department_id === 14 && !('weekly_capacity_hours' in lg.new), 'admin_log menyimpan nilai lama dan baru (tanpa kapasitas)', lg);
ok(String(await db.query("update admin_log set action='x'").catch(e => e.message)).includes('append-only'), 'admin_log append-only');
ok((await q('dev', 'select count(*)::int c from admin_log'))[0].c === 1, 'Developer bisa membaca admin_log');
ok((await q('mgr', 'select count(*)::int c from admin_log'))[0].c === 0, 'Manager tidak melihat admin_log');

// akun dinonaktifkan => kehilangan semua akses (JWT lama tidak berguna)
await upd('dev', U.stf2, 'staff', 14, false);
ok((await q('stf2', 'select id from tasks')).length === 0, 'akun nonaktif tidak melihat tugas apa pun');
ok((await q('stf2', 'select id from profiles')).length === 0, 'akun nonaktif tidak melihat profil');
ok(!!(await err('stf2', 'select report_progress($1,$2)', [t2, 'in_progress'])), 'akun nonaktif tidak bisa melapor');
ok((await upd('stf2', U.stf2, 'staff', 14, true) || '').includes('Hanya Developer'), 'akun nonaktif tidak bisa mengaktifkan diri sendiri');
await upd('dev', U.stf2, 'staff', 14, true);
ok((await q('stf2', 'select id from profiles')).length === 3, 'diaktifkan lagi => akses kembali (dirinya + rekan tim ME)');


// ---- ubah deadline & ganti PIC ----
U.stf3 = '00000000-0000-0000-0000-000000000006';
await db.exec(`insert into auth.users (id) values ('${U.stf3}');
  insert into profiles (id, full_name, role, department_id) values ('${U.stf3}', 'Staff4b', 'staff', 14);`);
const tm = (await q('spv', 'select create_task($1,$2,$3,$4,$5) id', ['Tugas kelola', null, 1, U.stf, '2099-02-01']))[0].id;
const dl = (id, d, why) => err('spv', 'select change_deadline($1,$2,$3)', [id, d, why]);

ok((await err('stf', 'select change_deadline($1,$2,$3)', [tm, '2099-03-01', 'x']) || '').includes('Tidak berwenang'), 'staff tidak boleh ubah deadline');
ok((await dl(tm, '2099-03-01', '  ') || '').includes('Alasan'), 'ubah deadline tanpa alasan ditolak');
ok((await dl(tm, '2099-02-01', 'sama') || '').includes('tidak berubah'), 'deadline sama ditolak');
ok(!(await dl(tm, '2099-03-01', 'menunggu material')), 'SPV mengubah deadline dengan alasan');
const dr = (await db.query('select original_deadline::text o, deadline::text d from tasks where id=$1', [tm])).rows[0];
ok(dr.o === '2099-02-01' && dr.d === '2099-03-01', 'deadline awal tetap, deadline sekarang berubah', dr);
const de = (await db.query("select old_values, new_values, note from task_events where task_id=$1 and event_type='deadline_change'", [tm])).rows;
ok(de.length === 1 && de[0].old_values.deadline === '2099-02-01' && de[0].new_values.deadline === '2099-03-01' && de[0].note === 'menunggu material', 'perubahan deadline tercatat lengkap');
ok((await err('req', 'select change_deadline($1,$2,$3)', [t2, '2099-03-01', 'x']) || '').includes('Tidak berwenang'), 'SPV departemen peminta tidak boleh ubah deadline (hanya tim ME/Manager)');

const rp = (who, id, pic, why) => err(who, 'select reassign_pic($1,$2,$3)', [id, pic, why]);
ok((await rp('req', tm, U.stf3, 'x') || '').includes('Tidak berwenang'), 'peminta dari departemen lain tidak boleh ganti PIC');
ok((await rp('spv', tm, U.stf3, '') || '').includes('Alasan'), 'ganti PIC tanpa alasan ditolak');
ok((await rp('spv', tm, U.stf, 'sama') || '').includes('tidak berubah'), 'PIC sama ditolak');
ok((await rp('spv', tm, U.mgr, 'pindah') || '').includes('tim ME'), 'ganti PIC ke orang di luar tim ME ditolak');
ok(!(await rp('spv', tm, U.stf3, 'cuti')), 'SPV ganti PIC dalam departemennya');
ok((await db.query('select pic_id from tasks where id=$1', [tm])).rows[0].pic_id === U.stf3, 'PIC berubah');
ok((await q('stf', 'select id from tasks where id = $1', [tm])).length === 1, 'PIC lama tetap melihat tugas (tim ME melihat semua)');
ok((await q('stf3', 'select id from tasks where id = $1', [tm])).length === 1, 'PIC baru melihat tugasnya');
const re = (await db.query("select old_values->>'pic_name' o, new_values->>'pic_name' n from task_events where task_id=$1 and event_type='reassign'", [tm])).rows[0];
ok(re.o === 'Staff4' && re.n === 'Staff4b', 'event mencatat nama PIC lama dan baru', re);
const rm = await q('mgr', "select pic, pic_department from export_tasks($1,$1) where title='Tugas kelola'", [wib(new Date())]);
ok(rm.length === 1 && rm[0].pic === 'Staff4b', 'export hari ini memakai PIC baru', rm);
const rmY = await q('mgr', "select pic from export_tasks($1,$1) where title='Tugas kelola'", [wib(new Date(Date.now() - 864e5))]);
ok(rmY.length === 0, 'tugas belum ada kemarin (dibuat hari ini)', rmY);
await q('mgr', "select report_progress($1,'cancelled',null,$2)", [tm, 'batal']);

// ---- notifikasi ----
const notifs = async (uid, taskId) => (await db.query(
  'select type, title, body, user_id from notifications where user_id=$1 and task_id=$2 order by id', [uid, taskId])).rows;
const nTask = (await q('spv', 'select create_task($1,$2,$3,$4,$5,$6) id', ['Notif satu', null, 1, U.stf, '2099-05-01', true]))[0].id;
let nPic = await notifs(U.stf, nTask);
ok(nPic.length === 1 && nPic[0].type === 'task_assigned' && nPic[0].title === 'Tugas baru (URGENT)' && nPic[0].body.includes('2099-05-01'), 'PIC dapat notifikasi tugas baru (urgent)', nPic);
ok((await notifs(U.spv, nTask)).length === 0, 'pembuat tugas tidak menerima notifikasi tugasnya sendiri');
const selfTask = (await q('spv', 'select create_task($1,$2,$3,$4,$5) id', ['Notif mandiri', null, 1, U.spv, '2099-05-01']))[0].id;
ok((await notifs(U.spv, selfTask)).length === 0, 'menugaskan diri sendiri tidak memicu notifikasi');

// RLS dan baca/tandai
ok((await q('stf', 'select id from notifications')).length >= 1 && (await q('stf2', 'select id from notifications where task_id=$1', [nTask])).length === 0, 'pengguna hanya melihat notifikasinya sendiri');
ok((await err('stf', "insert into notifications (user_id, type, title) values ($1,'x','y')", [U.stf]) || '').includes('permission denied'), 'klien tidak bisa membuat notifikasi');
const unread = async (uid) => (await db.query('select count(*)::int c from notifications where user_id=$1 and read_at is null', [uid])).rows[0].c;
const cnt = await unread(U.stf);
await q('stf2', 'select mark_notifications_read() n');
ok((await unread(U.stf)) === cnt, 'menandai dibaca tidak menyentuh milik orang lain');
ok((await q('stf', 'select mark_notifications_read() n'))[0].n === cnt && (await q('stf', 'select mark_notifications_read() n'))[0].n === 0, 'tandai semua dibaca: sekali berhasil, ulang 0');

// laporan progress => penerima yang tepat
await q('stf', 'select report_progress($1,$2,null,$3,null,$4)', [nTask, 'on_hold', 'tunggu material', [`${nTask}/h.jpg`]]);
const holdTo = (await db.query("select user_id from notifications where task_id=$1 and type='on_hold'", [nTask])).rows.map(r => r.user_id);
ok(holdTo.length === 1 && holdTo[0] === U.spv, 'Hold => hanya SPV departemen (bukan Manager, bukan PIC)', holdTo);
await q('stf', 'select report_progress($1,$2,null,$3,null,$4)', [nTask, 'done', 'selesai', [`${nTask}/d.jpg`]]);
const needTo = (await db.query("select user_id from notifications where task_id=$1 and type='approval_needed' order by user_id", [nTask])).rows.map(r => r.user_id);
ok(needTo.includes(U.spv) && needTo.includes(U.mgr) && !needTo.includes(U.stf) && !needTo.includes(U.stf2) && !needTo.includes(U.dev), 'Selesai => SPV departemen + Manager, bukan PIC/Developer/departemen lain', needTo);
await q('stf', 'select report_progress($1,$2,null,$3)', [nTask, 'done', 'catatan saja']);
ok((await db.query("select count(*)::int c from notifications where task_id=$1 and type='approval_needed'", [nTask])).rows[0].c === needTo.length, 'update tanpa ganti status tidak mengirim ulang');

await q('spv', "select set_approval($1,'rejected',$2)", [nTask, 'belum rapi']);
const ap1 = (await notifs(U.stf, nTask)).find(n => n.type === 'approval');
ok(ap1 && ap1.title === 'Tugas ditolak' && ap1.body.includes('belum rapi'), 'Reject => PIC dapat notifikasi beserta catatan', ap1);

await q('spv', 'select change_deadline($1,$2,$3)', [nTask, '2099-06-01', 'permintaan klien']);
ok((await notifs(U.stf, nTask)).some(n => n.type === 'deadline_changed' && n.body.includes('2099-05-01') && n.body.includes('2099-06-01')), 'ubah deadline => PIC diberi tahu (lama → baru)');
await q('spv', 'select reassign_pic($1,$2,$3)', [nTask, U.stf3, 'rotasi']);
ok((await notifs(U.stf3, nTask)).some(n => n.title === 'Tugas dialihkan ke Anda') && (await notifs(U.stf, nTask)).some(n => n.type === 'task_reassigned'), 'ganti PIC => PIC baru dan PIC lama diberi tahu');

// pengingat terjadwal
const mk = async (title) => (await q('spv', 'select create_task($1,$2,$3,$4,$5) id', [title, null, 1, U.stf, '2099-07-01']))[0].id;
const rSoon = await mk('Rem besok'), rLate = await mk('Rem telat'), rStale = await mk('Rem macet'), rHold = await mk('Rem hold'), rDone = await mk('Rem selesai');
await db.query("update tasks set deadline = (now() at time zone 'Asia/Jakarta')::date + 1 where id = $1", [rSoon]);
await db.query("update tasks set deadline = (now() at time zone 'Asia/Jakarta')::date - 2 where id = $1", [rLate]);
await db.query("update tasks set last_update_at = now() - interval '5 days' where id in ($1,$2)", [rStale, rHold]);
await db.query("update tasks set status='on_hold' where id = $1", [rHold]);
await db.query("update tasks set status='done', progress=100, deadline = (now() at time zone 'Asia/Jakarta')::date - 2, last_update_at = now() - interval '9 days' where id = $1", [rDone]);
await db.query('select generate_reminders()');
const types = async (id) => (await db.query("select user_id, type from notifications where task_id=$1 and type in ('deadline_soon','overdue','stale') order by type, user_id", [id])).rows;
let r1 = await types(rSoon);
ok(r1.length === 1 && r1[0].type === 'deadline_soon' && r1[0].user_id === U.stf, 'deadline besok => PIC', r1);
r1 = await types(rLate);
ok(r1.filter(x => x.type === 'overdue').map(x => x.user_id).sort().join() === [U.stf, U.spv].sort().join(), 'terlambat => PIC dan SPV departemen', r1);
r1 = await types(rStale);
ok(r1.filter(x => x.type === 'stale').length === 2, 'macet > 3 hari => PIC dan SPV', r1);
ok((await types(rHold)).filter(x => x.type === 'stale').length === 0, 'Hold tidak dianggap macet');
ok((await types(rDone)).length === 0, 'tugas selesai tidak diingatkan');
const before = (await db.query('select count(*)::int c from notifications')).rows[0].c;
await db.query('select generate_reminders()');
ok((await db.query('select count(*)::int c from notifications')).rows[0].c === before, 'menjalankan pengingat dua kali tidak menggandakan');
await db.query("insert into notifications (user_id, type, title, created_at) values ($1,'lama','x', now() - interval '61 days')", [U.stf]);
await db.query('select generate_reminders()');
ok((await db.query("select count(*)::int c from notifications where type='lama'")).rows[0].c === 0, 'notifikasi > 60 hari dibersihkan');
ok((await err('mgr', 'select generate_reminders()') || '').includes('permission denied'), 'klien tidak bisa menjalankan pengingat');

// langganan push
const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const sub = (who, ep, k = 'p256dhkey', a = 'authkey') => err(who, 'select save_push_subscription($1,$2,$3)', [ep, k, a]);
ok(!(await sub('stf', FCM)), 'langganan push FCM diterima');
for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://169.254.169.254/latest', 'https://x/' + 'a'.repeat(1100)]) {
  ok((await sub('stf', bad) || '').includes('tidak valid'), 'tolak endpoint: ' + bad.slice(0, 45));
}
ok(!(await sub('stf', 'https://updates.push.services.mozilla.com/wpush/v2/abc')) && !(await sub('stf', 'https://web.push.apple.com/QAbc')), 'Mozilla dan Apple diterima');
await sub('stf3', FCM);
ok((await db.query('select user_id from push_subscriptions where endpoint=$1', [FCM])).rows[0].user_id === U.stf3, 'endpoint pindah ke akun yang sedang login di perangkat itu');
await q('stf', 'select delete_push_subscription($1)', [FCM]);
ok((await db.query('select 1 from push_subscriptions where endpoint=$1', [FCM])).rows.length === 1, 'akun lain tidak bisa menghapus langganan bukan miliknya');
await q('stf3', 'select delete_push_subscription($1)', [FCM]);
ok((await db.query('select 1 from push_subscriptions where endpoint=$1', [FCM])).rows.length === 0, 'pemilik bisa menghapus langganannya');
ok((await err('mgr', 'select * from push_subscriptions') || '').includes('permission denied'), 'klien tidak bisa membaca langganan push');
for (let i = 0; i < 12; i++) await sub('stf2', `https://fcm.googleapis.com/fcm/send/dev${i}`);
ok((await db.query('select count(*)::int c from push_subscriptions where user_id=$1', [U.stf2])).rows[0].c === 10, 'maksimal 10 perangkat per akun');
await db.query('update profiles set is_active=false where id=$1', [U.stf3]);
ok((await sub('stf3', 'https://fcm.googleapis.com/fcm/send/zzz') || '').includes('tidak aktif'), 'akun nonaktif tidak bisa mendaftar push');
await db.query('update profiles set is_active=true where id=$1', [U.stf3]);

// ---- hapus log (Developer saja) ----
const DEV = '00000000-0000-0000-0000-0000000000d1';
await db.exec(`insert into auth.users (id) values ('${DEV}'); insert into profiles (id, full_name, role, department_id) values ('${DEV}', 'Dev', 'developer', 1);`);
U.dev = DEV;
const evIds = (await db.query('select id from task_events where task_id=$1 order by id', [t3])).rows.map(r => r.id);
ok(evIds.length >= 1, 'ada log untuk dihapus');
const createdId = (await db.query("select id from task_events where task_id=$1 and event_type='created'", [t3])).rows[0].id;
const delId = (await db.query("select id from task_events where event_type<>'created' order by id limit 1")).rows[0].id;
ok((await err('dev', 'select delete_task_events($1)', [[createdId]]) || '').includes('tidak boleh dihapus'), 'log "dibuat" tidak bisa dihapus (tugas akan hilang dari laporan)');
ok((await err('dev', 'select delete_task_events($1)', [[delId, createdId]]) || '').includes('tidak boleh dihapus'), 'campuran dengan log "dibuat" ditolak seluruhnya');
ok((await db.query('select 1 from task_events where id=$1', [createdId])).rows.length === 1 && (await db.query('select 1 from task_events where id=$1', [delId])).rows.length === 1, 'penolakan tidak menghapus apa pun');
for (const who of ['stf', 'spv', 'mgr']) {
  ok((await err(who, 'select delete_task_events($1)', [[evIds[0]]]) || '').includes('Hanya Developer'), `${who} tidak boleh hapus log`);
}
ok((await err('dev', 'select delete_task_events($1)', [[]]) || '').includes('Pilih 1'), 'daftar kosong ditolak');
ok(String(await db.query('delete from task_events where id=$1', [evIds[0]]).catch(e => e.message)).includes('append-only'), 'DELETE langsung tetap diblokir');
const withPhoto = (await db.query('select event_id from attachments where event_id is not null limit 1')).rows[0]?.event_id;
ok((await q('dev', 'select delete_task_events($1) n', [[delId]]))[0].n === 1, 'Developer menghapus 1 log');
ok((await db.query('select 1 from task_events where id=$1', [delId])).rows.length === 0, 'log benar-benar hilang');
ok((await db.query("select current_setting('app.dev_delete', true) v")).rows[0].v !== 'on', 'penanda tidak menempel setelah transaksi selesai');
const rest = (await db.query('select id from task_events limit 1')).rows[0];
ok(String(await db.query('delete from task_events where id=$1', [rest.id]).catch(e => e.message)).includes('append-only'), 'setelah itu DELETE langsung tetap diblokir');
if (withPhoto) {
  const before = (await db.query('select count(*)::int c from attachments')).rows[0].c;
  await q('dev', 'select delete_task_events($1)', [[withPhoto]]);
  const after = (await db.query('select count(*)::int c from attachments')).rows[0].c;
  ok(after === before && (await db.query('select count(*)::int c from attachments where event_id=$1', [withPhoto])).rows[0].c === 0, 'foto tetap ada, hanya putus dari log');
}

// ---- peminta dari departemen lain (model app khusus tim ME) ----
const reqTask = (await q('req', 'select create_task($1,$2,$3,$4,$5) id', ['Minta dari dept 5', null, 5, U.stf, future]))[0].id;
ok((await err('req', 'select report_progress($1,$2,$3)', [reqTask, 'in_progress', 10]) || '').includes('Tidak berwenang'), 'peminta dari departemen lain tidak bisa lapor progress');
ok((await err('req', 'select reassign_pic($1,$2,$3)', [reqTask, U.stf2, 'x']) || '').includes('Tidak berwenang'), 'peminta tidak bisa ganti PIC');
ok(!(await err('stf3', 'select report_progress($1,$2,$3,$4,$5,$6)', [reqTask, 'in_progress', 10, null, null, [`${reqTask}/w.jpg`]])), 'staff ME bisa melapor tugas rekan satu tim (kerja bersama)');
{
  const got = (await db.query("select user_id from notifications where task_id=$1 and type='progress'", [reqTask])).rows.map(r => r.user_id);
  const active = (await db.query('select id from profiles where is_active')).rows.map(r => r.id);
  ok(got.length === active.length - 1 && !got.includes(U.stf3) && active.filter(id => id !== U.stf3).every(id => got.includes(id)),
    'update progres diumumkan ke semua pengguna aktif kecuali pelaku', `${got.length}/${active.length}`);
}
ok(!(await rp('stf', reqTask, U.stf2, 'handover ke rekan')), 'staff ME bisa handover PIC ke sesama anggota ME');
ok((await err('stf', 'select change_deadline($1,$2,$3)', [reqTask, '2099-03-01', 'x']) || '').includes('Tidak berwenang'), 'staff tidak bisa ubah deadline');
await q('stf2', 'select report_progress($1,$2,$3,$4,$5,$6)', [reqTask, 'done', 100, 'selesai', null, [`${reqTask}/a.jpg`]]);
ok((await db.query("select count(*)::int c from notifications where task_id=$1 and user_id=$2 and type='progress'", [reqTask, U.req])).rows[0].c === 1,
  'pengajuan Selesai: SPV peminta hanya dapat notifikasi khusus, tidak dobel siaran progres');
await db.exec(`insert into attachments (task_id, storage_path, uploaded_by) values ('${reqTask}', '${reqTask}/a.jpg', '${U.stf}') on conflict do nothing`).catch(() => {});
await q('req', "select set_approval($1,'approved')", [reqTask]);
ok((await q('req', 'select approval from tasks where id=$1', [reqTask]))[0].approval === 'approved', 'peminta menyetujui hasil permintaannya sendiri');
const reqRows = await q('req', "select title from export_tasks('2020-01-01','2099-12-31')");
ok(reqRows.length === 1 && reqRows[0].title === 'Minta dari dept 5', 'export SPV peminta hanya berisi permintaan departemennya', JSON.stringify(reqRows));
const note = (await db.query("select user_id from notifications where task_id=$1 and type='approval_needed'", [reqTask])).rows.map(r => r.user_id);
ok(note.includes(U.req) && note.includes(U.spv), 'notifikasi "menunggu penilaian" ke SPV ME dan SPV peminta', JSON.stringify(note));

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
