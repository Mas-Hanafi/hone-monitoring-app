-- =====================================================================
-- Web app monitoring tugas staff: skema Supabase (Postgres 15+)
--
-- Prinsip:
--  1. Semua tulis ke tugas lewat fungsi (RPC). Tidak ada INSERT/UPDATE/DELETE
--     langsung dari klien, jadi log dan aturan bisnis selalu ikut jalan.
--  2. task_events bersifat append-only (dijaga trigger di level database).
--  3. Tidak ada hapus permanen: tugas dibatalkan, akun dinonaktifkan.
--  4. Semua tanggal laporan dihitung dalam WIB (Asia/Jakarta).
-- =====================================================================

-- ---------- Tipe ----------
create type app_role   as enum ('staff', 'supervisor', 'manager', 'developer');
create type task_status as enum ('not_started', 'in_progress', 'on_hold', 'done', 'handover', 'cancelled');
create type event_type as enum ('created', 'update', 'deadline_change', 'reassign', 'approval');
create type approval_status as enum ('pending', 'approved', 'hold', 'rejected');

-- ---------- Departemen ----------
create table departments (
  id         int generated always as identity primary key,
  name       text not null unique,
  sort_order int  not null default 0,
  is_active  boolean not null default true
);

insert into departments (name, sort_order) values
  ('Operasional', 1), ('Marcomm', 2), ('Sales', 3), ('FnB Service', 4),
  ('FnB Product', 5), ('Resort', 6), ('HK', 7), ('IT', 8), ('FO', 9),
  ('Store', 10), ('HRD', 11), ('Finance/Purchasing', 12), ('Sipil', 13), ('ME', 14), ('Garden', 15);

-- ---------- Profil user (1:1 dengan auth.users) ----------
-- Dibuat oleh developer lewat Edge Function (undangan), bukan self-signup.
create table profiles (
  id                    uuid primary key references auth.users (id) on delete restrict,
  full_name             text not null,
  role                  app_role not null default 'staff',
  department_id         int not null references departments (id),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now()
);

-- ---------- Tugas / project (satu tingkat) ----------
create table tasks (
  id                      uuid primary key default gen_random_uuid(),
  task_no                 bigint generated always as identity unique,   -- tampilkan sebagai TSK-0001 di UI
  title                   text not null check (length(trim(title)) between 1 and 200),
  description             text check (length(description) <= 2000),
  requester_department_id int not null references departments (id),
  pic_id                  uuid not null references profiles (id),
  pic_department_id       int not null references departments (id),    -- disimpan saat penugasan
  created_by              uuid not null references profiles (id),
  status                  task_status not null default 'not_started',
  is_urgent               boolean not null default false,
  approval                approval_status not null default 'pending',
  progress                smallint not null default 0 check (progress between 0 and 100),
  original_deadline       date not null,
  deadline                date not null,
  latest_note             text check (length(latest_note) <= 1000),
  assigned_at             timestamptz not null default now(),
  started_at              timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,
  last_update_at          timestamptz not null default now(),
  constraint done_means_100 check (status not in ('done', 'handover') or progress = 100)
);
create index tasks_pic_idx        on tasks (pic_id);
create index tasks_pic_dept_idx   on tasks (pic_department_id);
create index tasks_status_idx     on tasks (status);
create index tasks_deadline_idx   on tasks (deadline);

-- ---------- Log aktivitas (append-only) ----------
create table task_events (
  id         bigint generated always as identity primary key,
  task_id    uuid not null references tasks (id),
  actor_id   uuid not null references profiles (id),
  event_type event_type not null,
  old_values jsonb,
  new_values jsonb,
  note       text check (length(note) <= 1000),
  client_id  uuid,                               -- kunci idempotensi (antrean offline)
  created_at timestamptz not null default now()
);
create index task_events_task_idx    on task_events (task_id, created_at desc);
create index task_events_created_idx on task_events (created_at);
create unique index task_events_client_id_idx on task_events (client_id) where client_id is not null;

create function block_event_mutation() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Satu pengecualian: delete_task_events() (khusus Developer) menyalakan penanda ini selama transaksinya
  if tg_table_name = 'task_events' and tg_op = 'DELETE' and current_setting('app.dev_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'Tabel % bersifat append-only', tg_table_name;
end $$;

create trigger task_events_immutable
  before update or delete on task_events
  for each row execute function block_event_mutation();
create trigger task_events_no_truncate
  before truncate on task_events
  for each statement execute function block_event_mutation();

-- ---------- Foto (file ada di Storage bucket privat 'task-photos') ----------
create table attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks (id),
  event_id     bigint references task_events (id),
  storage_path text not null unique,             -- '<task_id>/<nama-file>'
  uploaded_by  uuid not null references profiles (id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz                       -- diisi saat file dihapus otomatis
);
create index attachments_task_idx on attachments (task_id);

-- ---------- Pengaturan ----------
create table app_settings (
  key   text primary key,
  value jsonb not null
);
insert into app_settings (key, value) values
  ('photo_retention_days', '3'),
  ('routine_drive_folder_id', '""'),
  ('photo_required_on_status_change', 'true');

-- ---------- Log export & snapshot bulanan ----------
create table export_logs (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references profiles (id),
  period_start date not null,
  period_end   date not null,
  row_count    int  not null,
  created_at   timestamptz not null default now()
);

create table monthly_snapshots (
  period    text primary key check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- contoh: 2026-11
  rows      jsonb not null,
  closed_by uuid not null references profiles (id),
  closed_at timestamptz not null default now()
);

create trigger export_logs_immutable
  before update or delete on export_logs
  for each row execute function block_event_mutation();
create trigger monthly_snapshots_immutable
  before update or delete on monthly_snapshots
  for each row execute function block_event_mutation();

-- =====================================================================
-- Fungsi bantu
-- =====================================================================
create function current_app_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and is_active
$$;

create function current_dept_id() returns int
language sql stable security definer set search_path = public as $$
  select department_id from profiles where id = auth.uid() and is_active
$$;

-- Departemen "ME": satu-satunya departemen yang boleh jadi PIC (departemen lain hanya meminta tugas)
create function me_dept_id() returns int
language sql stable security definer set search_path = public as $$
  select id from departments where name = 'ME'
$$;

-- Nama saja (bukan role/departemen) untuk menampilkan siapa pengunggah foto atau pelaku
-- perubahan, termasuk orang di departemen lain yang tidak terlihat lewat RLS profiles.
create function person_names(p_ids uuid[]) returns table (id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name from profiles p
  where current_app_role() is not null and p.id = any (p_ids) and cardinality(p_ids) <= 100
$$;

-- Hanya Developer. Menghapus log aktivitas tugas TANPA jejak (permintaan pemilik: keputusan disengaja).
-- Foto yang terkait tetap ada, hanya putus dari log. Laporan periode lama bisa berubah jika log yang dihapus ikut dihitung.
create function delete_task_events(p_event_ids bigint[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if current_app_role() is distinct from 'developer' then
    raise exception 'Hanya Developer yang dapat menghapus log';
  end if;
  if p_event_ids is null or cardinality(p_event_ids) = 0 or cardinality(p_event_ids) > 500 then
    raise exception 'Pilih 1 sampai 500 log';
  end if;
  -- Event "dibuat" menjadi sumber PIC awal dan keberadaan tugas di laporan/Log: tanpanya tugas hilang dari laporan.
  if exists (select 1 from task_events where id = any (p_event_ids) and event_type = 'created') then
    raise exception 'Log "dibuat" tidak boleh dihapus: tugasnya akan hilang dari laporan';
  end if;
  perform set_config('app.dev_delete', 'on', true);
  update attachments set event_id = null where event_id = any (p_event_ids);
  delete from task_events where id = any (p_event_ids);
  get diagnostics n = row_count;
  insert into admin_log (actor_id, target_id, action, details)
  values (auth.uid(), auth.uid(), 'delete_task_events', jsonb_build_object('count', n));
  perform set_config('app.dev_delete', 'off', true);
  return n;
end $$;

-- =====================================================================
-- Keadaan tugas pada akhir suatu hari (WIB), direkonstruksi dari task_events.
-- Dipakai export dan close_month, sehingga angka periode lama tidak berubah
-- oleh update yang terjadi sesudahnya. Hanya dipanggil dari fungsi lain.
-- =====================================================================
create type export_row as (
  task_no          bigint,
  title            text,
  requester        text,
  pic              text,
  pic_department   text,
  status           task_status,
  approval         text,
  urgency          text,
  progress_start   int,            -- progress di akhir hari sebelum periode (null = belum ada)
  progress_end     int,            -- progress di akhir periode
  original_deadline date,
  deadline         date,
  assigned_on      date,
  started_on       date,
  completed_on     date,
  closed_on        date,
  last_update_on   date,
  latest_note      text
);

create function task_state_asof(p_asof date)
returns table (
  task_id uuid, task_no bigint, title text, requester text, pic text,
  pic_department text, pic_department_id int, status task_status, approval approval_status,
  is_urgent boolean,
  progress int, original_deadline date, deadline date, assigned_on date,
  started_on date, completed_on date, closed_on date, last_update_on date,
  latest_note text
)
language sql stable security definer set search_path = public as $$
  with cutoff as (
    select ((p_asof + 1)::timestamp at time zone 'Asia/Jakarta') as ts
  ), s as (
    select
      t.id, t.task_no, t.title, t.original_deadline, t.assigned_at,
      rd.name as requester,
      coalesce((u.new_values ->> 'status')::task_status, 'not_started')            as status,
      coalesce((ap.new_values ->> 'approval')::approval_status, 'pending') as approval,
      coalesce((u.new_values ->> 'progress')::int, 0)                              as progress,
      coalesce((u.new_values ->> 'is_urgent')::boolean,
               (cr.new_values ->> 'is_urgent')::boolean, false)                    as is_urgent,
      coalesce((d.new_values ->> 'deadline')::date, t.original_deadline)           as deadline,
      coalesce((r.new_values ->> 'pic_id')::uuid,
               (cr.new_values ->> 'pic_id')::uuid)                                 as pic_id,
      coalesce((r.new_values ->> 'pic_department_id')::int,
               (cr.new_values ->> 'pic_department_id')::int)                       as pic_dept_id,
      n.note, st.ts as started_ts, dn.ts as done_ts, cn.ts as cancel_ts, lu.ts as last_ts
    from cutoff c
    join tasks t        on t.assigned_at < c.ts
    join departments rd on rd.id = t.requester_department_id
    left join lateral (
      select e.new_values from task_events e
      where e.task_id = t.id and e.event_type = 'created' limit 1) cr on true
    left join lateral (
      select e.new_values from task_events e
      where e.task_id = t.id and e.event_type in ('update', 'approval') and e.created_at < c.ts
        and e.new_values ->> 'status' is not null
      order by e.created_at desc, e.id desc limit 1) u on true
    left join lateral (
      select e.new_values from task_events e
      where e.task_id = t.id and e.event_type in ('update', 'approval') and e.created_at < c.ts
        and e.new_values ->> 'approval' is not null
      order by e.created_at desc, e.id desc limit 1) ap on true
    left join lateral (
      select e.new_values from task_events e
      where e.task_id = t.id and e.event_type = 'deadline_change' and e.created_at < c.ts
      order by e.created_at desc, e.id desc limit 1) d on true
    left join lateral (
      select e.new_values from task_events e
      where e.task_id = t.id and e.event_type = 'reassign' and e.created_at < c.ts
      order by e.created_at desc, e.id desc limit 1) r on true
    left join lateral (
      select e.note from task_events e
      where e.task_id = t.id and e.event_type in ('update', 'approval') and e.note is not null
        and e.created_at < c.ts
      order by e.created_at desc, e.id desc limit 1) n on true
    left join lateral (
      select min(e.created_at) as ts from task_events e
      where e.task_id = t.id and e.event_type in ('update', 'approval') and e.created_at < c.ts
        and e.new_values ->> 'status' in ('in_progress', 'on_hold', 'done', 'handover')) st on true
    -- awal rangkaian status selesai/handover yang sedang berlaku
    left join lateral (
      select min(e.created_at) as ts from task_events e
      where e.task_id = t.id and e.event_type in ('update', 'approval') and e.created_at < c.ts
        and e.new_values ->> 'status' in ('done', 'handover')
        and e.created_at > coalesce((
              select max(x.created_at) from task_events x
              where x.task_id = t.id and x.event_type in ('update', 'approval') and x.created_at < c.ts
                and x.new_values ->> 'status' not in ('done', 'handover')), '-infinity'::timestamptz)) dn on true
    left join lateral (
      select min(e.created_at) as ts from task_events e
      where e.task_id = t.id and e.event_type in ('update', 'approval') and e.created_at < c.ts
        and e.new_values ->> 'status' = 'cancelled'
        and e.created_at > coalesce((
              select max(x.created_at) from task_events x
              where x.task_id = t.id and x.event_type in ('update', 'approval') and x.created_at < c.ts
                and x.new_values ->> 'status' <> 'cancelled'), '-infinity'::timestamptz)) cn on true
    left join lateral (
      select max(e.created_at) as ts from task_events e
      where e.task_id = t.id and e.created_at < c.ts) lu on true
  )
  select
    s.id, s.task_no, s.title, s.requester, p.full_name, pd.name, pd.id,
    s.status, s.approval, s.is_urgent, s.progress, s.original_deadline, s.deadline,
    (s.assigned_at at time zone 'Asia/Jakarta')::date,
    (s.started_ts  at time zone 'Asia/Jakarta')::date,
    case when s.status in ('done', 'handover')
         then (s.done_ts at time zone 'Asia/Jakarta')::date end,
    case when s.status in ('done', 'handover') then (s.done_ts   at time zone 'Asia/Jakarta')::date
         when s.status = 'cancelled'           then (s.cancel_ts at time zone 'Asia/Jakarta')::date end,
    (s.last_ts at time zone 'Asia/Jakarta')::date,
    s.note
  from s
  join profiles    p  on p.id  = s.pic_id
  join departments pd on pd.id = s.pic_dept_id
$$;

-- Baris export untuk satu periode. p_dept null = semua departemen.
create function export_rows(p_start date, p_end date, p_dept int)
returns setof export_row
language sql stable security definer set search_path = public as $$
  select e.task_no, e.title, e.requester, e.pic, e.pic_department, e.status,
         case e.approval when 'approved' then 'Approve' when 'rejected' then 'Reject'
                         when 'hold' then 'Hold' else 'Pending' end,
         case when e.is_urgent then 'Urgent' else 'Normal' end,
         s.progress, e.progress, e.original_deadline, e.deadline,
         e.assigned_on, e.started_on, e.completed_on, e.closed_on,
         e.last_update_on, e.latest_note
  from task_state_asof(p_end) e
  left join task_state_asof(p_start - 1) s on s.task_id = e.task_id
  where coalesce(e.closed_on, date '9999-12-31') >= p_start
    -- SPV: tugas timnya (PIC) dan tugas yang departemennya minta
    and (p_dept is null or e.pic_department_id = p_dept
         or exists (select 1 from tasks t where t.id = e.task_id and t.requester_department_id = p_dept))
  order by e.task_no
$$;

-- Foto yang sudah lewat masa simpan (dibaca Edge Function terjadwal, service role)
create view attachments_expired as
select a.id, a.storage_path
from attachments a
where a.deleted_at is null
  and a.created_at < now() - make_interval(
        days => (select (value #>> '{}')::int from app_settings where key = 'photo_retention_days'));

-- File di bucket yang tidak punya baris attachments (unggah sukses, laporan gagal).
-- Dibaca Edge Function terjadwal yang sama; dihapus lewat Storage API.
create view storage_orphans as
select o.name as storage_path
from storage.objects o
where o.bucket_id = 'task-photos'
  and o.created_at < now() - interval '1 day'
  and not exists (select 1 from attachments a where a.storage_path = o.name);

-- =====================================================================
-- Fungsi RPC (satu-satunya jalur tulis dari klien)
-- =====================================================================

-- SPV/Manager membuat tugas dan menugaskan PIC
create function create_task(
  p_title text,
  p_description text,
  p_requester_department_id int,
  p_pic_id uuid,
  p_deadline date,
  p_is_urgent boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := current_app_role();
  v_pic  profiles%rowtype;
  v_id   uuid;
begin
  if v_role is null or v_role not in ('supervisor', 'manager', 'developer') then
    raise exception 'Hanya SPV atau Manager yang dapat membuat tugas';
  end if;

  select * into v_pic from profiles where id = p_pic_id and is_active and department_id = me_dept_id();
  if not found then
    raise exception 'PIC harus anggota tim ME yang aktif';
  end if;

  if p_deadline < (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Deadline tidak boleh di masa lalu';
  end if;

  insert into tasks (title, description, requester_department_id, pic_id, pic_department_id,
                     created_by, is_urgent, original_deadline, deadline)
  values (trim(p_title), p_description, p_requester_department_id, v_pic.id, v_pic.department_id,
          auth.uid(), p_is_urgent, p_deadline, p_deadline)
  returning id into v_id;

  insert into task_events (task_id, actor_id, event_type, new_values)
  values (v_id, auth.uid(), 'created',
          jsonb_build_object('pic_id', v_pic.id, 'pic_department_id', v_pic.department_id,
                             'deadline', p_deadline, 'is_urgent', p_is_urgent));

  if v_pic.id <> auth.uid() then
    perform notify_user(v_pic.id, 'task_assigned', case when p_is_urgent then 'Tugas baru (URGENT)' else 'Tugas baru' end,
                        trim(p_title) || ' · deadline ' || p_deadline, v_id);
  end if;

  return v_id;
end $$;

-- PIC (atau atasannya) melaporkan status/progress/catatan/foto
create function report_progress(
  p_task_id uuid,
  p_status task_status,
  p_progress int default null,                  -- null = pertahankan progress sekarang
  p_note text default null,
  p_is_urgent boolean default null,
  p_photo_paths text[] default '{}',
  p_client_id uuid default null                 -- kunci idempotensi dari antrean offline
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role     app_role := current_app_role();
  t          tasks%rowtype;
  v_progress int := p_progress;
  v_urgent   boolean;
  v_old      jsonb;
  v_new      jsonb;
  v_event    bigint;
  v_path     text;
  v_photo_required boolean;
  v_approval approval_status;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or v_role is null then
    raise exception 'Tugas tidak ditemukan';
  end if;

  -- Kirim ulang dari antrean offline: sudah tercatat, abaikan
  if p_client_id is not null and exists (select 1 from task_events where client_id = p_client_id) then
    return;
  end if;

  v_progress := coalesce(p_progress, t.progress);

  if not (t.pic_id = auth.uid()
          or v_role in ('manager', 'developer')
          or t.pic_department_id = current_dept_id()) then   -- seluruh tim ME mengerjakan tugas bersama
    raise exception 'Tidak berwenang memperbarui tugas ini';
  end if;

  if v_role = 'staff' and t.status in ('handover', 'cancelled') then
    raise exception 'Tugas yang sudah ditutup tidak dapat diubah';
  end if;
  if p_status = 'cancelled' and v_role = 'staff' then
    raise exception 'Hanya SPV atau Manager yang dapat membatalkan tugas';
  end if;

  if p_status in ('done', 'handover') then
    v_progress := 100;
  end if;
  if v_progress is null or v_progress not between 0 and 100 then
    raise exception 'Progress harus 0 sampai 100';
  end if;

  if (p_status = 'on_hold' or v_progress < t.progress)
     and coalesce(trim(p_note), '') = '' then
    raise exception 'Catatan wajib diisi saat tugas di-hold atau progress turun';
  end if;

  select (value #>> '{}')::boolean into v_photo_required
  from app_settings where key = 'photo_required_on_status_change';
  if coalesce(v_photo_required, false) and v_role = 'staff'
     and p_status <> t.status and cardinality(p_photo_paths) = 0 then
    raise exception 'Foto wajib dilampirkan saat status berubah';
  end if;

  foreach v_path in array p_photo_paths loop
    if v_path not like (t.id::text || '/%') then
      raise exception 'Path foto tidak valid';
    end if;
  end loop;

  v_urgent := coalesce(p_is_urgent, t.is_urgent);
  -- Diajukan selesai/handover (atau diajukan ulang setelah Reject) => menunggu penilaian lagi
  v_approval := case when p_status in ('done', 'handover') and p_status <> t.status
                     then 'pending' else t.approval end;
  v_old := jsonb_build_object('status', t.status, 'progress', t.progress, 'is_urgent', t.is_urgent,
                              'approval', t.approval);
  v_new := jsonb_build_object('status', p_status, 'progress', v_progress, 'is_urgent', v_urgent,
                              'approval', v_approval);

  if v_old = v_new and coalesce(trim(p_note), '') = '' and cardinality(p_photo_paths) = 0 then
    raise exception 'Tidak ada perubahan untuk disimpan';
  end if;

  update tasks set
    status         = p_status,
    progress       = v_progress,
    is_urgent      = v_urgent,
    approval       = v_approval,
    latest_note    = coalesce(nullif(trim(p_note), ''), latest_note),
    started_at     = case when p_status in ('in_progress', 'on_hold', 'done', 'handover')
                          then coalesce(started_at, now()) else started_at end,
    completed_at   = case when p_status in ('done', 'handover') then coalesce(completed_at, now())
                          when p_status = 'cancelled' then completed_at
                          else null end,
    cancelled_at   = case when p_status = 'cancelled'
                          then coalesce(cancelled_at, now()) else null end,
    last_update_at = now()
  where id = t.id;

  insert into task_events (task_id, actor_id, event_type, old_values, new_values, note, client_id)
  values (t.id, auth.uid(), 'update', v_old, v_new, nullif(trim(p_note), ''), p_client_id)
  returning id into v_event;

  insert into attachments (task_id, event_id, storage_path, uploaded_by)
  select t.id, v_event, u.path, auth.uid() from unnest(p_photo_paths) as u(path);

  -- Setiap update progres diumumkan ke semua pengguna aktif (kecuali pelaku); yang sudah dapat
  -- notifikasi khusus di bawah (menunggu penilaian / hold) tidak dapat dobel.
  perform notify_everyone(t.id, auth.uid(), 'Update progres',
    coalesce((select full_name from profiles where id = auth.uid()), '?') || ' · ' || t.title || ' → ' ||
    case p_status when 'not_started' then 'Belum dimulai' when 'in_progress' then 'Dikerjakan' when 'on_hold' then 'Hold'
                  when 'done' then 'Selesai' when 'handover' then 'Handover' else 'Dibatalkan' end || ' ' || v_progress || '%',
    p_status <> t.status and p_status in ('done', 'handover', 'on_hold'),
    p_status <> t.status and p_status in ('done', 'handover'));

  if p_status <> t.status then
    if p_status in ('done', 'handover') then
      perform notify_dept_leads(t.id, true, 'approval_needed', 'Menunggu penilaian', t.title, auth.uid());
    elsif p_status = 'on_hold' then
      perform notify_dept_leads(t.id, false, 'on_hold', 'Tugas di-hold', t.title || coalesce(' — ' || nullif(trim(p_note), ''), ''), auth.uid());
    end if;
  end if;
end $$;

-- Ubah deadline (wajib alasan; deadline awal tetap tersimpan)
create function change_deadline(p_task_id uuid, p_new_deadline date, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := current_app_role();
  t      tasks%rowtype;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or v_role is null or v_role = 'staff'
     or (v_role = 'supervisor' and t.pic_department_id <> current_dept_id()) then
    raise exception 'Tidak berwenang mengubah deadline tugas ini';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Alasan perubahan deadline wajib diisi';
  end if;
  if p_new_deadline = t.deadline then
    raise exception 'Deadline tidak berubah';
  end if;

  update tasks set deadline = p_new_deadline where id = t.id;

  insert into task_events (task_id, actor_id, event_type, old_values, new_values, note)
  values (t.id, auth.uid(), 'deadline_change',
          jsonb_build_object('deadline', t.deadline),
          jsonb_build_object('deadline', p_new_deadline),
          trim(p_reason));

  if t.pic_id <> auth.uid() then
    perform notify_user(t.pic_id, 'deadline_changed', 'Deadline berubah',
                        t.title || ': ' || t.deadline || ' → ' || p_new_deadline || ' (' || trim(p_reason) || ')', t.id);
  end if;
end $$;

-- Ganti PIC (wajib alasan; departemen PIC ikut berubah)
create function reassign_pic(p_task_id uuid, p_new_pic_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := current_app_role();
  t      tasks%rowtype;
  v_pic  profiles%rowtype;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or v_role is null
     or (v_role in ('staff', 'supervisor') and t.pic_department_id <> current_dept_id()) then   -- handover antar anggota ME
    raise exception 'Tidak berwenang mengganti PIC tugas ini';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Alasan penggantian PIC wajib diisi';
  end if;

  select * into v_pic from profiles where id = p_new_pic_id and is_active and department_id = me_dept_id();
  if not found then
    raise exception 'PIC baru harus anggota tim ME yang aktif';
  end if;
  if v_pic.id = t.pic_id then
    raise exception 'PIC tidak berubah';
  end if;

  update tasks set pic_id = v_pic.id, pic_department_id = v_pic.department_id where id = t.id;

  insert into task_events (task_id, actor_id, event_type, old_values, new_values, note)
  values (t.id, auth.uid(), 'reassign',
          jsonb_build_object('pic_id', t.pic_id, 'pic_department_id', t.pic_department_id,
                             'pic_name', (select full_name from profiles where id = t.pic_id)),
          jsonb_build_object('pic_id', v_pic.id, 'pic_department_id', v_pic.department_id,
                             'pic_name', v_pic.full_name),
          trim(p_reason));

  if v_pic.id <> auth.uid() then
    perform notify_user(v_pic.id, 'task_assigned', 'Tugas dialihkan ke Anda', t.title, t.id);
  end if;
  if t.pic_id <> auth.uid() then
    perform notify_user(t.pic_id, 'task_reassigned', 'Tugas dialihkan ke orang lain', t.title || ' — ' || trim(p_reason), t.id);
  end if;
end $$;

-- SPV/Manager menilai tugas: Approve, Hold, atau Reject (Pending hanya diatur sistem).
-- Reject mengembalikan tugas selesai/handover ke Dikerjakan. Hold dan Reject wajib catatan.
-- Menilai tugas yang PIC-nya diri sendiri: boleh untuk Developer dan untuk Manager/SPV tim ME (departemen PIC),
-- karena PIC selalu anggota ME dan penilaian tidak boleh menunggu departemen lain. Tercatat di log atas nama pelaku.
create function set_approval(p_task_id uuid, p_decision approval_status, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role   app_role := current_app_role();
  t        tasks%rowtype;
  v_status task_status;
  v_old    jsonb;
  v_new    jsonb;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or v_role is null or v_role = 'staff'
     or (v_role = 'supervisor' and t.pic_department_id <> current_dept_id()
         and t.requester_department_id <> current_dept_id()) then   -- tim ME atau departemen peminta
    raise exception 'Tidak berwenang menilai tugas ini';
  end if;
  if t.pic_id = auth.uid() and v_role <> 'developer'
     and not (v_role in ('manager', 'supervisor') and current_dept_id() = t.pic_department_id) then
    raise exception 'Tidak boleh menilai tugas sendiri';
  end if;
  if t.status = 'cancelled' then
    raise exception 'Tugas yang dibatalkan tidak dapat dinilai';
  end if;
  if p_decision = 'pending' then
    raise exception 'Pilih Approve, Hold, atau Reject';
  end if;
  if p_decision in ('hold', 'rejected') and coalesce(trim(p_note), '') = '' then
    raise exception 'Catatan wajib diisi untuk Hold atau Reject';
  end if;
  if p_decision = t.approval and coalesce(trim(p_note), '') = '' then
    raise exception 'Penilaian tidak berubah';
  end if;

  v_status := case when p_decision = 'rejected' and t.status in ('done', 'handover')
                   then 'in_progress' else t.status end;

  v_old := jsonb_build_object('approval', t.approval);
  v_new := jsonb_build_object('approval', p_decision);
  if v_status <> t.status then   -- status ikut berubah: catat lengkap supaya riwayat per tanggal akurat
    v_old := v_old || jsonb_build_object('status', t.status, 'progress', t.progress, 'is_urgent', t.is_urgent);
    v_new := v_new || jsonb_build_object('status', v_status, 'progress', t.progress, 'is_urgent', t.is_urgent);
  end if;

  update tasks set
    approval       = p_decision,
    status         = v_status,
    completed_at   = case when v_status in ('done', 'handover') then completed_at else null end,
    latest_note    = coalesce(nullif(trim(p_note), ''), latest_note),
    last_update_at = now()
  where id = t.id;

  insert into task_events (task_id, actor_id, event_type, old_values, new_values, note)
  values (t.id, auth.uid(), 'approval', v_old, v_new, nullif(trim(p_note), ''));

  if t.pic_id <> auth.uid() then   -- menilai tugas sendiri tidak perlu memberi tahu diri sendiri
    perform notify_user(t.pic_id, 'approval',
                        case p_decision when 'approved' then 'Tugas disetujui' when 'rejected' then 'Tugas ditolak'
                                        else 'Tugas di-hold' end,
                        t.title || coalesce(' — ' || nullif(trim(p_note), ''), ''), t.id);
  end if;
end $$;

-- Export: hanya SPV/Manager/Developer; SPV dibatasi departemennya.
-- Berhalaman karena Data API membatasi baris per respons (default 1000).
-- Klien mengulang dengan p_after = task_no terakhir sampai hasil kosong.
-- Setiap halaman dicatat di export_logs.
create function export_tasks(
  p_start date,
  p_end date,
  p_after bigint default 0,
  p_limit int default 500
) returns setof export_row
language plpgsql security definer set search_path = public as $$
declare
  v_role  app_role := current_app_role();
  v_dept  int := case when current_app_role() = 'supervisor' then current_dept_id() end;
  v_count int;
begin
  if v_role is null or v_role not in ('supervisor', 'manager', 'developer') then
    raise exception 'Tidak berwenang melakukan export';
  end if;
  if p_end < p_start then
    raise exception 'Periode tidak valid';
  end if;
  if p_limit not between 1 and 1000 then
    raise exception 'p_limit harus 1 sampai 1000';
  end if;

  return query
    select * from export_rows(p_start, p_end, v_dept) r
    where r.task_no > p_after
    order by r.task_no
    limit p_limit;
  get diagnostics v_count = row_count;

  insert into export_logs (user_id, period_start, period_end, row_count)
  values (auth.uid(), p_start, p_end, v_count);
end $$;

-- Tutup bulan: bekukan rekap bulanan sebagai keadaan di akhir bulan itu
-- (bukan keadaan saat tombol ditekan). Hanya bulan yang sudah berakhir.
-- TODO: export dari snapshot (bulan yang sudah ditutup) dikerjakan di Edge Function.
create function close_month(p_period text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role  app_role := current_app_role();
  v_start date;
  v_end   date;
begin
  if v_role is null or v_role not in ('manager', 'developer') then
    raise exception 'Hanya Manager yang dapat menutup bulan';
  end if;
  if p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Format periode harus YYYY-MM';
  end if;
  if exists (select 1 from monthly_snapshots where period = p_period) then
    raise exception 'Bulan % sudah ditutup', p_period;
  end if;

  v_start := (p_period || '-01')::date;
  v_end   := (v_start + interval '1 month')::date - 1;
  if v_end >= (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Bulan % belum berakhir', p_period;
  end if;

  insert into monthly_snapshots (period, rows, closed_by)
  select p_period,
         coalesce(jsonb_agg(to_jsonb(r) order by r.task_no), '[]'::jsonb),
         auth.uid()
  from export_rows(v_start, v_end, null) r;
end $$;

-- =====================================================================
-- Row Level Security
-- Tidak ada policy INSERT/UPDATE/DELETE: tulis hanya lewat fungsi di atas.
-- =====================================================================
alter table departments       enable row level security;
alter table profiles          enable row level security;
alter table tasks             enable row level security;
alter table task_events       enable row level security;
alter table attachments       enable row level security;
alter table app_settings      enable row level security;
alter table export_logs       enable row level security;
alter table monthly_snapshots enable row level security;

create policy departments_read on departments for select to authenticated
  using (current_app_role() is not null);

create policy settings_read on app_settings for select to authenticated
  using (current_app_role() is not null);

create policy profiles_read on profiles for select to authenticated
  using (current_app_role() is not null and (
    id = auth.uid()
    or current_app_role() in ('manager', 'developer')
    or (current_app_role() in ('supervisor', 'staff') and department_id in (current_dept_id(), me_dept_id()))
  ));

-- App ini khusus tim ME: semua pengguna aktif (termasuk staff) melihat beban kerja ME.
-- Menulis tetap dibatasi di fungsi RPC (staff hanya bisa melapor tugasnya sendiri).
create policy tasks_read on tasks for select to authenticated
  using (current_app_role() is not null);

-- Log dan foto mengikuti visibilitas tugasnya
create policy events_read on task_events for select to authenticated
  using (exists (select 1 from tasks t where t.id = task_events.task_id));

create policy attachments_read on attachments for select to authenticated
  using (exists (select 1 from tasks t where t.id = attachments.task_id));

create policy export_logs_read on export_logs for select to authenticated
  using (current_app_role() in ('manager', 'developer'));

create policy snapshots_read on monthly_snapshots for select to authenticated
  using (current_app_role() in ('manager', 'developer'));

-- =====================================================================
-- Storage: bucket privat untuk foto. Path wajib '<task_id>/<nama-file>'.
-- Tidak ada policy UPDATE/DELETE: penghapusan hanya oleh Edge Function (service role).
-- =====================================================================
-- Foto dikompres di HP (~300 KB); batas 1,5 MB menolak file besar atau bukan gambar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-photos', 'task-photos', false, 1572864, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy photos_read on storage.objects for select to authenticated
  using (bucket_id = 'task-photos'
         and exists (select 1 from tasks t where t.id::text = (storage.foldername(name))[1]));

-- Unggah hanya oleh yang boleh lapor progres: tim ME, manager, developer (departemen peminta tidak)
create policy photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'task-photos'
              and (current_app_role() in ('manager', 'developer') or current_dept_id() = me_dept_id())
              and exists (select 1 from tasks t where t.id::text = (storage.foldername(name))[1]));

-- =====================================================================
-- Notifikasi (di dalam app + push HP)
-- notifications: satu baris per penerima. Dibuat oleh fungsi di database (bukan klien).
-- Push dikirim Edge Function send-push yang menguras baris dengan pushed_at kosong.
-- =====================================================================
create table notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references profiles (id),
  type       text not null,
  title      text not null,
  body       text not null default '',
  task_id    uuid references tasks (id),
  dedupe_key text unique,                         -- pengingat terjadwal tidak dikirim dua kali
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  pushed_at  timestamptz
);
create index notifications_user_idx     on notifications (user_id, created_at desc);
create index notifications_unpushed_idx on notifications (created_at) where pushed_at is null;
alter table notifications enable row level security;
create policy notifications_read on notifications for select to authenticated
  using (user_id = auth.uid() and current_app_role() is not null);

create table push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references profiles (id),
  p256dh      text not null,
  auth_secret text not null,
  created_at  timestamptz not null default now()
);
alter table push_subscriptions enable row level security;   -- tanpa policy: hanya fungsi di bawah dan service role

create function notify_user(p_user uuid, p_type text, p_title text, p_body text, p_task uuid, p_key text default null)
returns void
language sql security definer set search_path = public as $$
  insert into notifications (user_id, type, title, body, task_id, dedupe_key)
  select p.id, p_type, p_title, left(coalesce(p_body, ''), 300), p_task, p_key
  from profiles p where p.id = p_user and p.is_active
  on conflict (dedupe_key) do nothing
$$;

-- SPV departemen PIC (dan opsional semua Manager), kecuali PIC dan pelaku sendiri
create function notify_dept_leads(
  p_task uuid, p_managers boolean, p_type text, p_title text, p_body text, p_exclude uuid, p_key text default null
) returns void
language sql security definer set search_path = public as $$
  insert into notifications (user_id, type, title, body, task_id, dedupe_key)
  select p.id, p_type, p_title, left(coalesce(p_body, ''), 300), t.id,
         case when p_key is null then null else p_key || ':' || p.id end
  from tasks t
  join profiles p on p.is_active and p.id <> t.pic_id and p.id is distinct from p_exclude
   and ((p.role = 'supervisor' and p.department_id in (t.pic_department_id, t.requester_department_id))
        or (p_managers and p.role = 'manager'))
  where t.id = p_task
  on conflict (dedupe_key) do nothing
$$;

-- Siaran ke semua pengguna aktif kecuali pelaku. p_skip_leads/p_skip_managers: lewati penerima yang
-- sudah dapat notifikasi khusus dari notify_dept_leads untuk kejadian yang sama.
create function notify_everyone(
  p_task uuid, p_actor uuid, p_title text, p_body text, p_skip_leads boolean, p_skip_managers boolean
) returns void
language sql security definer set search_path = public as $$
  insert into notifications (user_id, type, title, body, task_id)
  select p.id, 'progress', p_title, left(coalesce(p_body, ''), 300), t.id
  from tasks t
  join profiles p on p.is_active and p.id is distinct from p_actor
   and not (p.id <> t.pic_id and (
        (p_skip_leads and p.role = 'supervisor' and p.department_id in (t.pic_department_id, t.requester_department_id))
        or (p_skip_managers and p.role = 'manager')))
  where t.id = p_task
$$;

create function mark_notifications_read(p_ids bigint[] default null) returns int
language sql security definer set search_path = public as $$
  with u as (
    update notifications set read_at = now()
    where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
    returning 1)
  select count(*)::int from u
$$;

-- Hanya layanan push yang dikenal: Edge Function akan mengirim HTTP ke alamat ini,
-- jadi endpoint sembarang (SSRF) ditolak di sini dan sekali lagi di send-push.
create function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if current_app_role() is null then
    raise exception 'Akun tidak aktif';
  end if;
  if length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100
     or p_endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/' then
    raise exception 'Langganan push tidak valid';
  end if;
  -- Endpoint milik satu perangkat: kalau akun lain masuk di perangkat yang sama, pindah ke akun itu
  insert into push_subscriptions (endpoint, user_id, p256dh, auth_secret)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth_secret = excluded.auth_secret;
  -- Maksimal 10 perangkat per akun (yang terlama dibuang)
  delete from push_subscriptions s
  where s.user_id = auth.uid()
    and s.endpoint not in (
      select endpoint from push_subscriptions where user_id = auth.uid() order by created_at desc, endpoint limit 10);
end $$;

create function delete_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Pengingat terjadwal (dijalankan pg_cron tiap pagi WIB). Aman dijalankan berulang (dedupe_key).
create function generate_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  t record;
begin
  -- Jatuh tempo besok => PIC
  for t in select id, title, pic_id, deadline from tasks
           where status in ('not_started', 'in_progress', 'on_hold') and deadline = v_today + 1 loop
    perform notify_user(t.pic_id, 'deadline_soon', 'Deadline besok', t.title, t.id,
                        'soon:' || t.id || ':' || t.deadline);
  end loop;

  -- Terlambat => PIC dan SPV departemen, paling banyak sekali per minggu selama masih terlambat
  for t in select id, title, pic_id, deadline from tasks
           where status in ('not_started', 'in_progress', 'on_hold') and deadline < v_today loop
    perform notify_user(t.pic_id, 'overdue', 'Tugas terlambat', t.title || ' (deadline ' || t.deadline || ')', t.id,
                        'overdue:' || t.id || ':' || to_char(v_today, 'IYYY-IW') || ':' || t.pic_id);
    perform notify_dept_leads(t.id, false, 'overdue', 'Tugas terlambat', t.title || ' (deadline ' || t.deadline || ')',
                              null, 'overdue:' || t.id || ':' || to_char(v_today, 'IYYY-IW'));
  end loop;

  -- Macet (tanpa update > 3 hari; Hold tidak dihitung) => PIC dan SPV, sekali per episode
  for t in select id, title, pic_id, last_update_at from tasks
           where status in ('not_started', 'in_progress') and last_update_at < now() - interval '3 days' loop
    perform notify_user(t.pic_id, 'stale', 'Belum ada update', t.title || ' belum diperbarui lebih dari 3 hari', t.id,
                        'stale:' || t.id || ':' || (t.last_update_at at time zone 'Asia/Jakarta')::date || ':' || t.pic_id);
    perform notify_dept_leads(t.id, false, 'stale', 'Tugas macet', t.title || ' belum diperbarui lebih dari 3 hari',
                              null, 'stale:' || t.id || ':' || (t.last_update_at at time zone 'Asia/Jakarta')::date);
  end loop;

  delete from notifications where created_at < now() - interval '60 days';
end $$;

-- =====================================================================
-- Manajemen pengguna (khusus Developer)
-- Akun dibuat lewat Edge Function invite-user (service role). Perubahan profil
-- lewat admin_update_profile. Keduanya dicatat di admin_log (append-only).
-- =====================================================================
create table admin_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid not null references profiles (id),
  target_id  uuid not null references profiles (id),
  action     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table admin_log enable row level security;
create policy admin_log_read on admin_log for select to authenticated
  using (current_app_role() = 'developer');
create trigger admin_log_immutable
  before update or delete on admin_log
  for each row execute function block_event_mutation();
create trigger admin_log_no_truncate
  before truncate on admin_log
  for each statement execute function block_event_mutation();

create function admin_update_profile(
  p_user_id uuid,
  p_role app_role,
  p_department_id int,
  p_is_active boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare
  old profiles%rowtype;
begin
  if current_app_role() is distinct from 'developer' then
    raise exception 'Hanya Developer yang dapat mengubah pengguna';
  end if;
  select * into old from profiles where id = p_user_id for update;
  if not found then
    raise exception 'Pengguna tidak ditemukan';
  end if;
  if p_user_id = auth.uid() and (p_role <> 'developer' or not p_is_active) then
    raise exception 'Tidak boleh menurunkan atau menonaktifkan akun sendiri';
  end if;
  if not exists (select 1 from departments where id = p_department_id and is_active) then
    raise exception 'Departemen tidak valid';
  end if;

  update profiles set role = p_role, department_id = p_department_id, is_active = p_is_active
  where id = p_user_id;

  insert into admin_log (actor_id, target_id, action, details)
  values (auth.uid(), p_user_id, 'update_profile', jsonb_build_object(
    'old', jsonb_build_object('role', old.role, 'department_id', old.department_id, 'is_active', old.is_active),
    'new', jsonb_build_object('role', p_role, 'department_id', p_department_id, 'is_active', p_is_active)));
end $$;

-- =====================================================================
-- Antrean sinkron ke Google Sheet (satu arah: app -> sheet)
-- Setiap insert/update tugas mengantrekan task_id (satu baris per tugas).
-- Edge Function sync-sheet menguras antrean, lalu menulis baris ke Sheet.
-- Antrean dipakai (bukan panggilan HTTP dari trigger) supaya ada retry dan
-- penulisan ke Sheets bisa dikelompokkan (batas API ~60 tulis per menit).
-- =====================================================================
create table sheet_outbox (
  task_id   uuid primary key references tasks (id),
  queued_at timestamptz not null default clock_timestamp()
);
alter table sheet_outbox enable row level security;   -- tanpa policy: hanya service role

create function enqueue_sheet_sync() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into sheet_outbox (task_id) values (new.id)
  on conflict (task_id) do update set queued_at = clock_timestamp();
  return null;
end $$;

create trigger tasks_sheet_sync
  after insert or update on tasks
  for each row execute function enqueue_sheet_sync();

-- Hapus dari antrean hanya baris yang PERSIS sama dengan yang dibaca
-- (task_id + queued_at). Tugas yang berubah lagi saat sinkron berjalan
-- punya queued_at baru, jadi tetap antre dan tidak hilang.
create function ack_sheet_outbox(p_task_ids uuid[], p_queued_at timestamptz[])
returns int
language sql security definer set search_path = public as $$
  with d as (
    delete from sheet_outbox o
    using unnest(p_task_ids, p_queued_at) as a(task_id, queued_at)
    where o.task_id = a.task_id and o.queued_at = a.queued_at
    returning 1)
  select count(*)::int from d
$$;

-- =====================================================================
-- Hak akses. Default privilege diubah dulu supaya tabel/fungsi BARU tidak
-- otomatis terbuka ke anon/authenticated (jalankan sebagai role postgres).
-- Fungsi baru yang memang boleh dipanggil klien harus di-grant eksplisit.
-- =====================================================================
-- Catatan: default PUBLIC execute hanya bisa dicabut tanpa "in schema".
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;

revoke all on all tables in schema public from anon, authenticated;
grant select on departments, profiles, tasks, task_events, attachments,
                app_settings, export_logs, monthly_snapshots, admin_log, notifications to authenticated;

revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated, service_role;
-- Fungsi internal: hanya dipanggil dari fungsi lain atau service role
revoke execute on function task_state_asof(date), export_rows(date, date, int),
                           block_event_mutation(), enqueue_sheet_sync(),
                           ack_sheet_outbox(uuid[], timestamptz[]), notify_user(uuid, text, text, text, uuid, text),
                           notify_dept_leads(uuid, boolean, text, text, text, uuid, text),
                           notify_everyone(uuid, uuid, text, text, boolean, boolean),
                           generate_reminders() from authenticated;

-- =====================================================================
-- Realtime: perubahan tugas dan notifikasi dikirim langsung ke klien (RLS tetap berlaku).
-- Dilewati bila publikasi supabase_realtime tidak ada (mis. database uji lokal).
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tasks') then
      alter publication supabase_realtime add table tasks;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') then
      alter publication supabase_realtime add table notifications;
    end if;
  end if;
end $$;

-- =====================================================================
-- Rutin tim ME: checklist harian/mingguan (Genset harian, Panel harian, Room mingguan).
-- Satu model untuk semua: template -> butir (items) -> objek yang diperiksa (subjects: Genset 1/2,
-- tiap panel, tiap kamar) -> satu isian per periode (runs) -> jawaban per butir x objek (answers).
-- Isian wajib bertanda tangan (gambar) dan berfoto. Tulis hanya lewat submit_routine_run; isian terkunci setelah dikirim (hanya manager/developer boleh membuka ulang).
-- Isian milik periode berjalan menurut WIB: harian = hari ini, mingguan = Senin minggu ini.
-- =====================================================================
create table routine_templates (
  id        int generated always as identity primary key,
  key       text not null unique,
  name      text not null,
  frequency text not null check (frequency in ('daily', 'weekly')),
  -- whole: semua objek wajib, satu isian per periode. per_subject: objek yang dipilih saja, boleh beberapa isian per periode.
  mode      text not null default 'whole' check (mode in ('whole', 'per_subject')),
  subject_noun text not null default 'objek',   -- sebutan objek di tampilan dan notifikasi (kamar, panel, genset)
  version   int  not null default 1,        -- naik bila butir diubah; isian lama tetap mencatat versinya
  sort      int  not null default 0,
  is_active boolean not null default true,
  created_by uuid references profiles (id),   -- null = rutinitas bawaan; terisi = ditambahkan dari aplikasi
  created_at timestamptz not null default now()
);

create table routine_subjects (
  id          int generated always as identity primary key,
  template_id int  not null references routine_templates (id),
  key         text not null,
  label       text not null,
  sort        int  not null default 0,
  is_active   boolean not null default true,
  unique (template_id, key)
);

create table routine_items (
  id          int generated always as identity primary key,
  template_id int  not null references routine_templates (id),
  section     text not null,
  label       text not null,
  -- check: OK/NG; check_na: OK/NG/N/A; number: angka (atau N/A); text: catatan bebas (opsional)
  kind        text not null check (kind in ('check', 'check_na', 'number', 'text')),
  unit        text,
  -- run: diisi sekali per isian; subject: diisi untuk setiap objek (Genset 1 dan 2, tiap panel, tiap kamar)
  scope       text not null check (scope in ('run', 'subject')),
  sort        int  not null default 0,
  is_active   boolean not null default true
);

create table routine_runs (
  id               uuid primary key default gen_random_uuid(),
  template_id      int  not null references routine_templates (id),
  template_version int  not null,
  period           date not null,            -- harian: tanggalnya; mingguan: hari Senin
  inspector_id     uuid not null references profiles (id),
  ng_count         int  not null default 0,
  submitted_at     timestamptz not null default now(),
  archived_at      timestamptz,      -- diisi Edge Function archive-routine setelah bukti tersalin ke Google Drive
  drive_folder_url text,
  whole            boolean not null default true   -- false: isian sebagian (mode per_subject)
);
create unique index routine_runs_whole_uniq on routine_runs (template_id, period) where whole;

create table routine_answers (
  id         bigint generated always as identity primary key,
  run_id     uuid not null references routine_runs (id) on delete cascade,
  item_id    int  not null references routine_items (id),
  subject_id int  references routine_subjects (id),
  status     text not null check (status in ('ok', 'ng', 'na')),
  num        numeric,
  note       text
);
create unique index routine_answers_uniq on routine_answers (run_id, item_id, coalesce(subject_id, 0));
create index routine_runs_period_idx on routine_runs (template_id, period desc);
create index routine_runs_unarchived_idx on routine_runs (submitted_at) where archived_at is null;

create function can_read_routine() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() in ('manager', 'developer', 'supervisor') or current_dept_id() = me_dept_id(), false)
$$;

-- Yang boleh mengisi: tim ME (semua peran di departemen ME) dan developer. Manager di luar ME hanya melihat.
create function can_fill_routine() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() = 'developer' or current_dept_id() = me_dept_id(), false)
$$;

alter table routine_templates enable row level security;
alter table routine_subjects  enable row level security;
alter table routine_items     enable row level security;
alter table routine_runs      enable row level security;
alter table routine_answers   enable row level security;
create policy routine_templates_read on routine_templates for select to authenticated using (can_read_routine());
create policy routine_subjects_read  on routine_subjects  for select to authenticated using (can_read_routine());
create policy routine_items_read     on routine_items     for select to authenticated using (can_read_routine());
create policy routine_runs_read      on routine_runs      for select to authenticated using (can_read_routine());
create policy routine_answers_read   on routine_answers   for select to authenticated using (can_read_routine());
grant select on routine_templates, routine_subjects, routine_items, routine_runs, routine_answers to authenticated;

-- Bukti per isian: tepat satu tanda tangan (gambar) dan 1 sampai 6 foto, disimpan di bucket privat routine-files.
-- Berkas diunggah klien lebih dulu ke '<kunci checklist>/<periode>/<id pengisi>/<nama>', lalu dirujuk saat submit.
create table routine_files (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references routine_runs (id) on delete cascade,
  kind         text not null check (kind in ('photo', 'signature')),
  storage_path text not null unique,
  uploaded_by  uuid not null references profiles (id),
  created_at   timestamptz not null default now(),
  drive_file_id text,                     -- salinan di Google Drive (diisi archive-routine)
  drive_url     text
);
create index routine_files_run_idx on routine_files (run_id);
alter table routine_files enable row level security;
create policy routine_files_read on routine_files for select to authenticated using (can_read_routine());
grant select on routine_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('routine-files', 'routine-files', false, 1572864, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create policy routine_files_read_obj on storage.objects for select to authenticated
  using (bucket_id = 'routine-files' and can_read_routine());
create policy routine_files_upload_obj on storage.objects for insert to authenticated
  with check (bucket_id = 'routine-files' and can_fill_routine() and (storage.foldername(name))[3] = auth.uid()::text);

-- Objek yang sudah diperiksa pada suatu periode (untuk checklist mode per_subject, mis. Room: kamar yang sedang terisi
-- tamu boleh dilewati dan diperiksa belakangan). Satu objek hanya sekali per periode.
create table routine_run_subjects (
  run_id      uuid not null references routine_runs (id) on delete cascade,
  template_id int  not null references routine_templates (id),
  period      date not null,
  subject_id  int  not null references routine_subjects (id),
  primary key (run_id, subject_id),
  unique (template_id, period, subject_id)
);
alter table routine_run_subjects enable row level security;
create policy routine_run_subjects_read on routine_run_subjects for select to authenticated using (can_read_routine());
grant select on routine_run_subjects to authenticated;

-- Kirim isian periode berjalan. p_answers: [{item_id, subject_id, status, num, note}]; p_files: [{kind, path}]
-- mode 'whole'  : semua objek wajib terisi, satu isian per periode (Genset, Panel).
-- mode 'per_subject': hanya objek yang dikirim (minimal satu) yang wajib lengkap; boleh beberapa kali per periode,
--                  tiap objek sekali per periode (Room).
-- Semua butir non-teks pada objek yang dikirim wajib terjawab; NG wajib catatan; wajib 1 tanda tangan dan 1 sampai 6 foto.
create function submit_routine_run(p_template text, p_answers jsonb, p_files jsonb default '[]'::jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t       routine_templates;
  v_run   uuid;
  v_per   date;
  v_ng    int;
  v_miss  int;
  v_bad   int;
  v_body  text;
  v_pre   text;
  v_dup   text;
  v_name  text;
  v_objs  text;
  r       record;
begin
  if not can_fill_routine() then
    raise exception 'Hanya tim ME yang dapat mengisi rutin';
  end if;
  select * into t from routine_templates where key = p_template and is_active;
  if not found then raise exception 'Checklist tidak dikenal'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 3000
     or jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_files, '[]'::jsonb)) > 20 then
    raise exception 'Isian tidak valid';
  end if;

  v_per := case t.frequency
             when 'weekly' then date_trunc('week', (now() at time zone 'Asia/Jakarta'))::date
             else (now() at time zone 'Asia/Jakarta')::date
           end;
  if t.mode = 'whole' and exists (select 1 from routine_runs where template_id = t.id and period = v_per and whole) then
    raise exception 'Checklist periode ini sudah diisi';
  end if;

  create temp table _ans on commit drop as
    select (x ->> 'item_id')::int                       as item_id,
           nullif(x ->> 'subject_id', '')::int           as subject_id,
           x ->> 'status'                                as status,
           nullif(x ->> 'num', '')::numeric              as num,
           nullif(btrim(x ->> 'note'), '')               as note
    from jsonb_array_elements(p_answers) x;

  -- objek yang dikirim (mode per_subject hanya memeriksa objek ini)
  create temp table _chosen on commit drop as
    select distinct subject_id from _ans where subject_id is not null;
  if t.mode = 'per_subject' then
    if (select count(*) from _chosen) = 0 then raise exception 'Pilih minimal satu %', t.subject_noun; end if;
    select string_agg(s.label, ', ' order by s.sort) into v_dup
      from routine_run_subjects rs join routine_subjects s on s.id = rs.subject_id
      where rs.template_id = t.id and rs.period = v_per and rs.subject_id in (select subject_id from _chosen);
    if v_dup is not null then raise exception 'Sudah diperiksa periode ini: %', v_dup; end if;
  end if;

  create temp table _exp on commit drop as
    select i.id as item_id, case when i.scope = 'subject' then s.id end as subject_id, i.kind
    from routine_items i
    left join routine_subjects s on s.template_id = i.template_id and s.is_active and i.scope = 'subject'
    where i.template_id = t.id and i.is_active
      and (i.scope = 'run' or (s.id is not null and (t.mode = 'whole' or s.id in (select subject_id from _chosen))));

  select count(*) into v_bad from _ans a
    where not exists (select 1 from _exp e where e.item_id = a.item_id and e.subject_id is not distinct from a.subject_id);
  if v_bad > 0 then raise exception 'Isian tidak cocok dengan checklist'; end if;
  if (select count(*) from (select 1 from _ans group by item_id, coalesce(subject_id, 0) having count(*) > 1) d) > 0 then
    raise exception 'Isian ganda';
  end if;

  select count(*) into v_bad from _ans a join _exp e on e.item_id = a.item_id and e.subject_id is not distinct from a.subject_id
    where a.status is null or a.status not in ('ok', 'ng', 'na')
       or (e.kind = 'check'    and a.status = 'na')
       or (e.kind = 'number'   and (a.status = 'ng' or (a.status = 'ok' and a.num is null)))
       or (e.kind = 'text'     and (a.status <> 'ok' or a.note is null));
  if v_bad > 0 then raise exception 'Ada isian dengan nilai yang tidak sah'; end if;
  if exists (select 1 from _ans where status = 'ng' and note is null) then
    raise exception 'Setiap temuan NG wajib diberi catatan';
  end if;

  select count(*) into v_miss from _exp e
    where e.kind <> 'text'
      and not exists (select 1 from _ans a where a.item_id = e.item_id and a.subject_id is not distinct from e.subject_id);
  if v_miss > 0 then raise exception 'Masih % butir belum diisi', v_miss; end if;

  -- bukti: tanda tangan dan foto
  v_pre := t.key || '/' || v_per || '/' || auth.uid() || '/';
  create temp table _files on commit drop as
    select x ->> 'kind' as kind, x ->> 'path' as path from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) x;
  if exists (select 1 from _files where kind is null or kind not in ('photo', 'signature') or path is null or left(path, length(v_pre)) <> v_pre) then
    raise exception 'Berkas bukti tidak sah';
  end if;
  if exists (select 1 from _files f where not exists (select 1 from storage.objects o where o.bucket_id = 'routine-files' and o.name = f.path)) then
    raise exception 'Berkas bukti belum terunggah';
  end if;
  if (select count(*) from _files where kind = 'signature') <> 1 then raise exception 'Tanda tangan wajib (satu)'; end if;
  if (select count(*) from _files where kind = 'photo') not between 1 and 6 then raise exception 'Lampirkan 1 sampai 6 foto'; end if;

  select count(*) into v_ng from _ans where status = 'ng';
  insert into routine_runs (template_id, template_version, period, inspector_id, ng_count, whole)
  values (t.id, t.version, v_per, auth.uid(), v_ng, t.mode = 'whole') returning id into v_run;
  insert into routine_answers (run_id, item_id, subject_id, status, num, note)
    select v_run, item_id, subject_id, status, num, note from _ans;
  insert into routine_files (run_id, kind, storage_path, uploaded_by)
    select v_run, kind, path, auth.uid() from _files;
  if t.mode = 'per_subject' then
    insert into routine_run_subjects (run_id, template_id, period, subject_id)
      select v_run, t.id, v_per, subject_id from _chosen;
  end if;

  -- Setiap isian yang terkirim dikabari ke SEMUA akun aktif (kecuali pengisi): lonceng di app, dan push ke HP
  -- yang sudah mengaktifkan notifikasi. Temuan NG memakai judul "Temuan NG" dan menyebut butir pertama.
  select full_name into v_name from profiles where id = auth.uid();
  if t.mode = 'per_subject' then
    select string_agg(s.label, ', ' order by s.sort) into v_objs from _chosen c join routine_subjects s on s.id = c.subject_id;
  end if;
  if v_ng > 0 then
    select string_agg(x.txt, '; ') into v_body from (
      select coalesce(s.label || ' - ', '') || i.label as txt
      from _ans a join routine_items i on i.id = a.item_id left join routine_subjects s on s.id = a.subject_id
      where a.status = 'ng' order by i.sort limit 3) x;
  end if;
  for r in select id from profiles where is_active and id <> auth.uid() loop
    perform notify_user(
      r.id,
      case when v_ng > 0 then 'routine_ng' else 'routine' end,
      case when v_ng > 0 then 'Temuan NG: ' || t.name else 'Checklist ' || t.name || ' selesai' end,
      coalesce(v_name, 'Tim ME') || ' mengirim checklist ' || t.name || coalesce(' (' || case when lower(v_objs) like lower(t.subject_noun) || '%' then '' else t.subject_noun || ' ' end || v_objs || ')', '') || '. '
        || case when v_ng > 0 then v_ng || ' temuan NG: ' || coalesce(v_body, '') else 'Semua OK.' end,
      null, 'routine:' || v_run || ':' || r.id);
  end loop;
  return v_run;
end $$;

-- Buka ulang isian yang terkirim salah: isian dihapus agar bisa diisi lagi, dicatat di admin_log.
-- Hanya manager ME atau developer. Berkas bukti lama tetap di penyimpanan (yatim), tidak ikut dipakai.
create function reopen_routine_run(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t_name text; v_per date;
begin
  if not (current_app_role() in ('manager', 'developer') and can_fill_routine()) then
    raise exception 'Hanya manager ME atau developer yang dapat membuka ulang isian';
  end if;
  select rt.name, rr.period into t_name, v_per from routine_runs rr join routine_templates rt on rt.id = rr.template_id where rr.id = p_run;
  if not found then raise exception 'Isian tidak ditemukan'; end if;
  insert into admin_log (actor_id, target_id, action, details)
  values (auth.uid(), auth.uid(), 'reopen_routine_run', jsonb_build_object('template', t_name, 'period', v_per));
  delete from routine_runs where id = p_run;
end $$;

revoke execute on function can_read_routine(), can_fill_routine(), submit_routine_run(text, jsonb, jsonb), reopen_routine_run(uuid) from public, anon;
grant  execute on function can_read_routine(), can_fill_routine(), submit_routine_run(text, jsonb, jsonb), reopen_routine_run(uuid) to authenticated, service_role;

-- ---------- Data awal: tiga checklist dari berkas ME Daily Routine ----------
-- Panel per_subject: tiap panel diperiksa dan dikirim sendiri-sendiri (satu kali per hari), oleh siapa pun di tim ME.
insert into routine_templates (key, name, frequency, mode, subject_noun, sort) values
  ('genset', 'Genset', 'daily',  'whole',       'genset', 1),
  ('panel',  'Panel',  'daily',  'per_subject', 'panel',  2),
  ('room',   'Room',   'weekly', 'per_subject', 'kamar',  3);

insert into routine_subjects (template_id, key, label, sort)
select t.id, v.key, v.label, v.sort from routine_templates t
join (values
  ('genset', 'g1', 'Genset 1', 1), ('genset', 'g2', 'Genset 2', 2),
  ('panel',  'p1', 'Panel 1', 1),
  ('panel',  'p2', 'Panel 2', 2),
  ('panel',  'p3', 'Panel 3', 3),
  ('panel',  'p4', 'Panel 4', 4),
  ('panel',  'p5', 'Panel 5', 5),
  ('panel',  'p6', 'Panel 6', 6),
  ('panel',  'p7', 'Panel 7', 7),
  ('panel',  'p8', 'Panel 8', 8),
  ('panel',  'p9', 'Panel 9', 9),
  ('panel',  'p10', 'Panel 10', 10),
  ('panel',  'p11', 'Panel 11', 11),
  ('panel',  'p12', 'Panel 12', 12),
  ('panel',  'p13', 'Panel 13', 13),
  ('panel',  'p14', 'Panel 14', 14),
  ('panel',  'p15', 'Panel 15', 15),
  ('panel',  'p16', 'Panel 16', 16)
) v(tk, key, label, sort) on v.tk = t.key;

insert into routine_subjects (template_id, key, label, sort)
select (select id from routine_templates where key = 'room'), r, r, row_number() over (order by r)
from unnest(array['101','102','103','105','106','107','108',
                  '201','202','203','205','206','207','208','209','210','211',
                  '301','302','303','305','306','307','308','309','310','311',
                  '501','502','503']) r;

-- butir: (template, bagian, label, jenis, satuan, cakupan, urutan)
insert into routine_items (template_id, section, label, kind, unit, scope, sort)
select t.id, v.section, v.label, v.kind, v.unit, v.scope, v.sort
from routine_templates t join (values
  ('genset', 'Kondisi ruangan', 'Kebersihan ruangan', 'check', null, 'run', 1),
  ('genset', 'Kondisi ruangan', 'Pencahayaan', 'check', null, 'run', 2),
  ('genset', 'Kondisi ruangan', 'Kondisi APAR', 'check', null, 'run', 3),
  ('genset', 'Kondisi ruangan', 'Pintu akses', 'check', null, 'run', 4),
  ('genset', 'Kondisi ruangan', 'Kebocoran (OK = tidak ada)', 'check', null, 'run', 5),
  ('genset', 'Panel kelistrikan', 'Panel ATS', 'check', null, 'subject', 6),
  ('genset', 'Panel kelistrikan', 'Stabilizer', 'check', null, 'subject', 7),
  ('genset', 'Panel kelistrikan', 'Tegangan', 'number', 'V', 'subject', 8),
  ('genset', 'Panel kelistrikan', 'Kondisi kabel', 'check', null, 'subject', 9),
  ('genset', 'Unit genset', 'Bocor (OK = tidak bocor)', 'check', null, 'subject', 10),
  ('genset', 'Unit genset', 'Level oli', 'check', null, 'subject', 11),
  ('genset', 'Unit genset', 'Level coolant', 'check', null, 'subject', 12),
  ('genset', 'Unit genset', 'Level solar', 'check', null, 'subject', 13),
  ('genset', 'Unit genset', 'Tegangan', 'number', 'V', 'subject', 14),
  ('genset', 'Unit genset', 'Aki / baterai', 'check', null, 'subject', 15),
  ('genset', 'Unit genset', 'Gas buang', 'check', null, 'subject', 16),
  ('genset', 'Unit genset', 'Bodi', 'check', null, 'subject', 17),
  ('genset', 'Unit genset', 'Hourmeter', 'number', 'jam', 'subject', 18),

  ('panel', 'A. Kondisi umum dan keselamatan', 'Area panel bersih, kering, dan bebas debu berlebih', 'check_na', null, 'subject', 1),
  ('panel', 'A. Kondisi umum dan keselamatan', 'Tidak ada genangan air atau kebocoran di sekitar panel', 'check_na', null, 'subject', 2),
  ('panel', 'A. Kondisi umum dan keselamatan', 'Pintu panel dan kunci berfungsi dengan baik', 'check_na', null, 'subject', 3),
  ('panel', 'A. Kondisi umum dan keselamatan', 'Tanda bahaya listrik dan tegangan terpasang', 'check_na', null, 'subject', 4),
  ('panel', 'A. Kondisi umum dan keselamatan', 'Akses panel tidak terhalang', 'check_na', null, 'subject', 5),
  ('panel', 'A. Kondisi umum dan keselamatan', 'Ventilasi tidak tersumbat', 'check_na', null, 'subject', 6),
  ('panel', 'A. Kondisi umum dan keselamatan', 'Tidak ada bau terbakar, suara abnormal, atau indikasi overheating', 'check_na', null, 'subject', 7),
  ('panel', 'A. Kondisi umum dan keselamatan', 'APAR yang sesuai tersedia dan dapat diakses', 'check_na', null, 'subject', 8),
  ('panel', 'B. Pemeriksaan visual komponen', 'MCB/MCCB tidak menunjukkan kerusakan fisik', 'check_na', null, 'subject', 9),
  ('panel', 'B. Pemeriksaan visual komponen', 'Kontaktor dan relay tidak menunjukkan tanda terbakar atau kerusakan', 'check_na', null, 'subject', 10),
  ('panel', 'B. Pemeriksaan visual komponen', 'Busbar dan isolator tidak menunjukkan tanda terbakar atau kerusakan', 'check_na', null, 'subject', 11),
  ('panel', 'B. Pemeriksaan visual komponen', 'Terminal kabel tidak menunjukkan tanda overheating', 'check_na', null, 'subject', 12),
  ('panel', 'B. Pemeriksaan visual komponen', 'Kabel tidak terkelupas, terjepit, atau rusak isolatornya', 'check_na', null, 'subject', 13),
  ('panel', 'B. Pemeriksaan visual komponen', 'Tidak ada benda asing atau hewan dalam panel', 'check_na', null, 'subject', 14),
  ('panel', 'B. Pemeriksaan visual komponen', 'Indikator lampu dan display berfungsi', 'check_na', null, 'subject', 15),
  ('panel', 'B. Pemeriksaan visual komponen', 'Tidak ada kondensasi atau kelembaban berlebih', 'check_na', null, 'subject', 16),
  ('panel', 'C. Pengukuran listrik', 'Tegangan antar-fasa | R-S', 'number', 'V', 'subject', 17),
  ('panel', 'C. Pengukuran listrik', 'Tegangan antar-fasa | R-T', 'number', 'V', 'subject', 18),
  ('panel', 'C. Pengukuran listrik', 'Tegangan antar-fasa | S-T', 'number', 'V', 'subject', 19),
  ('panel', 'C. Pengukuran listrik', 'Tegangan fase-netral | R-N', 'number', 'V', 'subject', 20),
  ('panel', 'C. Pengukuran listrik', 'Tegangan fase-netral | S-N', 'number', 'V', 'subject', 21),
  ('panel', 'C. Pengukuran listrik', 'Tegangan fase-netral | T-N', 'number', 'V', 'subject', 22),
  ('panel', 'C. Pengukuran listrik', 'Arus per fase | R', 'number', 'A', 'subject', 23),
  ('panel', 'C. Pengukuran listrik', 'Arus per fase | S', 'number', 'A', 'subject', 24),
  ('panel', 'C. Pengukuran listrik', 'Arus per fase | T', 'number', 'A', 'subject', 25),
  ('panel', 'C. Pengukuran listrik', 'Faktor daya (bila ada meter)', 'number', null, 'subject', 26),
  ('panel', 'C. Pengukuran listrik', 'Arus netral', 'number', 'A', 'subject', 27),
  ('panel', 'D. Pemeriksaan termal dan beban', 'Suhu komponen utama diperiksa sesuai prosedur', 'check_na', null, 'subject', 28),
  ('panel', 'D. Pemeriksaan termal dan beban', 'Thermal scanning dilakukan bila diperlukan', 'check_na', null, 'subject', 29),
  ('panel', 'D. Pemeriksaan termal dan beban', 'Tidak ada hotspot yang melebihi batas pabrikan atau kriteria', 'check_na', null, 'subject', 30),
  ('panel', 'D. Pemeriksaan termal dan beban', 'Beban panel tidak melebihi kapasitas desain', 'check_na', null, 'subject', 31),
  ('panel', 'D. Pemeriksaan termal dan beban', 'Hasil pemeriksaan termal didokumentasikan bila dilakukan', 'check_na', null, 'subject', 32),
  ('panel', 'E. Temuan dan tindakan perbaikan', 'Temuan dan tindakan perbaikan', 'text', null, 'subject', 33),

  ('room', 'Kelistrikan', 'Filter AC', 'check_na', null, 'subject', 1),
  ('room', 'Kelistrikan', 'Lampu', 'check_na', null, 'subject', 2),
  ('room', 'Kelistrikan', 'Filter pool', 'check', null, 'subject', 3),
  ('room', 'Kelistrikan', 'Cool storage', 'check', null, 'subject', 4),
  ('room', 'Kelistrikan', 'Teko listrik', 'check_na', null, 'subject', 5),
  ('room', 'Kelistrikan', 'Brankas', 'check_na', null, 'subject', 6),
  ('room', 'Sipil', 'Kloset', 'check_na', null, 'subject', 7),
  ('room', 'Sipil', 'Wastafel', 'check_na', null, 'subject', 8),
  ('room', 'Sipil', 'Shower', 'check_na', null, 'subject', 9),
  ('room', 'Sipil', 'Pintu', 'check_na', null, 'subject', 10),
  ('room', 'Sipil', 'Cat', 'check_na', null, 'subject', 11),
  ('room', 'Catatan', 'Catatan', 'text', null, 'subject', 12)
) v(tk, section, label, kind, unit, scope, sort) on v.tk = t.key;

-- =====================================================================
-- Logbook shift tim ME: catatan kegiatan per shift (morning, evening, night) sekaligus serah terima (handover).
-- Semua anggota ME boleh menambah dan mengubah catatan siapa pun; setiap perubahan menyimpan isi lama sebagai
-- revisi (append-only), dan pembuat, pengubah terakhir, serta penyelesai selalu tercatat. Catatan berstatus 'open'
-- = pekerjaan belum selesai yang harus dilanjutkan shift berikutnya (tampil di daftar "Perlu dilanjutkan"
-- sampai ditandai selesai). Tanggal = tanggal MULAI shift (night yang melewati tengah malam tetap bertanggal
-- hari mulainya). Penulisan hanya lewat add_logbook_entry / edit_logbook_entry. Dibaca tim ME dan pimpinan.
-- =====================================================================
create table logbook_entries (
  id          bigint generated always as identity primary key,
  entry_date  date not null,
  shift       text not null check (shift in ('morning', 'evening', 'night')),
  entry_time  time,                                   -- jam kejadian (opsional)
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  status      text not null default 'done' check (status in ('done', 'open')),
  created_by  uuid not null references profiles (id),
  created_at  timestamptz not null default now(),
  updated_by  uuid references profiles (id),
  updated_at  timestamptz,
  revisions   int not null default 0,
  closed_by   uuid references profiles (id),          -- yang menandai selesai (status open -> done)
  closed_at   timestamptz
);
create index logbook_entries_day_idx  on logbook_entries (entry_date desc, shift, entry_time);
create index logbook_entries_open_idx on logbook_entries (entry_date desc) where status = 'open';

create table logbook_revisions (                      -- isi SEBELUM diubah
  id         bigint generated always as identity primary key,
  entry_id   bigint not null references logbook_entries (id),
  entry_time time,
  body       text not null,
  status     text,
  edited_by  uuid not null references profiles (id),
  edited_at  timestamptz not null default now()
);
create index logbook_revisions_entry_idx on logbook_revisions (entry_id, id);
create trigger logbook_revisions_immutable
  before update or delete on logbook_revisions
  for each row execute function block_event_mutation();

alter table logbook_entries   enable row level security;
alter table logbook_revisions enable row level security;
create policy logbook_entries_read   on logbook_entries   for select to authenticated using (can_read_routine());
create policy logbook_revisions_read on logbook_revisions for select to authenticated using (can_read_routine());
grant select on logbook_entries, logbook_revisions to authenticated;

create function add_logbook_entry(p_date date, p_shift text, p_time time, p_body text, p_status text default 'done') returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id    bigint;
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_name  text;
  r       record;
begin
  if not can_fill_routine() then raise exception 'Hanya tim ME yang dapat mengisi logbook'; end if;
  if p_shift is null or p_shift not in ('morning', 'evening', 'night') then raise exception 'Shift tidak dikenal'; end if;
  if p_status is null or p_status not in ('done', 'open') then raise exception 'Status tidak dikenal'; end if;
  if p_date is null or p_date < v_today - 7 or p_date > v_today + 1 then
    raise exception 'Tanggal logbook hanya boleh 7 hari ke belakang sampai besok';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'Isi kegiatan 1 sampai 2000 karakter';
  end if;
  insert into logbook_entries (entry_date, shift, entry_time, body, status, created_by)
  values (p_date, p_shift, p_time, btrim(p_body), p_status, auth.uid())
  returning id into v_id;

  -- pekerjaan yang harus dilanjutkan: kabari anggota ME lain (lonceng + push)
  if p_status = 'open' then
    select full_name into v_name from profiles where id = auth.uid();
    for r in select id from profiles where is_active and id <> auth.uid() and department_id = me_dept_id() loop
      perform notify_user(r.id, 'logbook', 'Handover logbook: perlu dilanjutkan',
                          coalesce(v_name, 'Tim ME') || ' (' || p_shift || '): ' || left(btrim(p_body), 200), null,
                          'logbook:' || v_id || ':' || r.id);
    end loop;
  end if;
  return v_id;
end $$;

-- Siapa pun di tim ME boleh mengubah atau menandai selesai; isi lama disimpan sebagai revisi.
-- Catatan selesai lebih dari 7 hari terkunci; catatan yang masih open tetap bisa diubah sampai ditandai selesai.
-- p_expected_revisions: jumlah revisi saat pengguna membuka catatan. Bila sudah berubah (orang lain menyimpan lebih dulu),
-- simpan ditolak supaya perubahan orang itu tidak tertimpa diam-diam. Null = tanpa pengecekan.
create function edit_logbook_entry(p_id bigint, p_time time, p_body text, p_status text, p_expected_revisions int default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  e       logbook_entries;
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
begin
  if not can_fill_routine() then raise exception 'Hanya tim ME yang dapat mengubah logbook'; end if;
  if p_status is null or p_status not in ('done', 'open') then raise exception 'Status tidak dikenal'; end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'Isi kegiatan 1 sampai 2000 karakter';
  end if;
  select * into e from logbook_entries where id = p_id for update;
  if not found then raise exception 'Catatan tidak ditemukan'; end if;
  if p_expected_revisions is not null and e.revisions <> p_expected_revisions then
    raise exception 'Catatan sudah diubah orang lain. Muat ulang lalu ulangi perubahan Anda';
  end if;
  if e.status = 'done' and e.entry_date < v_today - 7 then raise exception 'Catatan lebih dari 7 hari sudah terkunci'; end if;
  if e.body = btrim(p_body) and e.entry_time is not distinct from p_time and e.status = p_status then return; end if;  -- tidak ada perubahan
  insert into logbook_revisions (entry_id, entry_time, body, status, edited_by) values (e.id, e.entry_time, e.body, e.status, auth.uid());
  update logbook_entries
     set body = btrim(p_body), entry_time = p_time, status = p_status,
         updated_by = auth.uid(), updated_at = now(), revisions = revisions + 1,
         closed_by = case when p_status = 'done' and e.status = 'open' then auth.uid() when p_status = 'open' then null else e.closed_by end,
         closed_at = case when p_status = 'done' and e.status = 'open' then now()      when p_status = 'open' then null else e.closed_at end
   where id = e.id;
end $$;

revoke execute on function add_logbook_entry(date, text, time, text, text), edit_logbook_entry(bigint, time, text, text, int) from public, anon;
grant  execute on function add_logbook_entry(date, text, time, text, text), edit_logbook_entry(bigint, time, text, text, int) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'logbook_entries') then
    alter publication supabase_realtime add table logbook_entries;
  end if;
end $$;

-- =====================================================================
-- Status online (khusus Developer) dan Log Activity (semua akun aktif, hanya baca; jenis pengguna/ekspor khusus Developer)
-- user_presence: waktu terakhir tiap akun membuka app (ping ~1 menit selama app terlihat). Hanya Developer yang bisa membaca.
-- activity_feed: gabungan semua perubahan (tugas, rutin, logbook, kelola pengguna, ekspor) jadi kalimat kronologis.
-- Login/keluar akun tidak dicatat. Data yang sudah dihapus tidak muncul.
-- =====================================================================
create table user_presence (
  user_id      uuid primary key references profiles (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table user_presence enable row level security;
create policy user_presence_read on user_presence for select to authenticated
  using (current_app_role() = 'developer');
grant select on user_presence to authenticated;

create function touch_presence() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_app_role() is null then return; end if;
  insert into user_presence (user_id, last_seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = now();
end $$;
revoke execute on function touch_presence() from public, anon;
grant  execute on function touch_presence() to authenticated, service_role;

create function act_status_label(s text) returns text
language sql immutable set search_path = public as $$
  select case s when 'not_started' then 'Belum dimulai' when 'in_progress' then 'Dikerjakan' when 'on_hold' then 'Hold'
                when 'done' then 'Selesai' when 'handover' then 'Handover' when 'cancelled' then 'Dibatalkan' else coalesce(s, '-') end
$$;

create function act_approval_label(s text) returns text
language sql immutable set search_path = public as $$
  select case s when 'pending' then 'Pending' when 'approved' then 'Approve' when 'hold' then 'Hold' when 'rejected' then 'Reject' else coalesce(s, '-') end
$$;

create function activity_feed(
  p_before timestamptz default null,
  p_actor  uuid default null,
  p_kind   text default null,
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_search text default null,
  p_limit  int default 100
) returns table (happened_at timestamptz, actor_id uuid, actor_name text, kind text, summary text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  if current_app_role() is null then raise exception 'Akun tidak aktif'; end if;
  return query
  with feed as (
    -- Tugas
    select e.created_at as at, e.actor_id as aid, 'task'::text as k,
      case e.event_type
        when 'created' then 'membuat tugas TSK-' || lpad(t.task_no::text, 4, '0') || ' "' || t.title || '" (PIC '
             || coalesce((select p.full_name from profiles p where p.id = (e.new_values->>'pic_id')::uuid), '-')
             || ', dari ' || coalesce((select d.name from departments d where d.id = t.requester_department_id), '-') || ')'
        when 'update' then 'memperbarui TSK-' || lpad(t.task_no::text, 4, '0') || ' "' || t.title || '": ' ||
             coalesce(nullif(array_to_string(array_remove(array[
               case when e.old_values->>'status' is distinct from e.new_values->>'status'
                    then 'status ' || act_status_label(e.old_values->>'status') || ' → ' || act_status_label(e.new_values->>'status') end,
               case when e.old_values->>'progress' is distinct from e.new_values->>'progress'
                    then 'progres ' || (e.old_values->>'progress') || '% → ' || (e.new_values->>'progress') || '%' end,
               case when e.old_values->>'is_urgent' is distinct from e.new_values->>'is_urgent'
                    then case when (e.new_values->>'is_urgent')::boolean then 'ditandai urgent' else 'urgent dicabut' end end
             ], null), ', '), ''), 'menambah catatan')
        when 'deadline_change' then 'mengubah deadline TSK-' || lpad(t.task_no::text, 4, '0') || ' "' || t.title || '" dari '
             || (e.old_values->>'deadline') || ' ke ' || (e.new_values->>'deadline')
        when 'reassign' then 'mengalihkan PIC TSK-' || lpad(t.task_no::text, 4, '0') || ' "' || t.title || '" dari '
             || coalesce(e.old_values->>'pic_name', '-') || ' ke ' || coalesce(e.new_values->>'pic_name', '-')
        when 'approval' then 'menilai TSK-' || lpad(t.task_no::text, 4, '0') || ' "' || t.title || '": ' || act_approval_label(e.new_values->>'approval')
             || case when e.new_values ? 'status' and e.old_values->>'status' is distinct from e.new_values->>'status'
                     then ' (status kembali ke ' || act_status_label(e.new_values->>'status') || ')' else '' end
        else e.event_type::text end as s,
      e.note as d
    from task_events e join tasks t on t.id = e.task_id
    union all
    -- Rutin
    select r.submitted_at, r.inspector_id, 'routine',
      'mengirim checklist ' || tp.name || ' periode ' || r.period::text
        || coalesce(' (' || (select string_agg(sj.label, ', ' order by sj.sort) from routine_run_subjects rs
                              join routine_subjects sj on sj.id = rs.subject_id where rs.run_id = r.id) || ')', '')
        || case when r.ng_count > 0 then ', ' || r.ng_count || ' butir NG' else ', semua OK' end,
      null
    from routine_runs r join routine_templates tp on tp.id = r.template_id
    union all
    -- Logbook
    select t2.created_at, t2.created_by, 'routine',
      'menambah rutinitas "' || t2.name || '" (' || case t2.frequency when 'weekly' then 'mingguan' else 'harian' end || ')', null
    from routine_templates t2 where t2.created_by is not null
    union all
    select l.created_at, l.created_by, 'logbook',
      'menambah catatan logbook shift ' || l.shift || case when l.status = 'open' or l.closed_at is not null then ' (perlu dilanjutkan)' else '' end,
      left(l.body, 160)
    from logbook_entries l
    union all
    select v.edited_at, v.edited_by, 'logbook',
      'mengubah catatan logbook shift ' || l.shift || ' tanggal ' || l.entry_date::text,
      'sebelumnya: ' || left(v.body, 160)
    from logbook_revisions v join logbook_entries l on l.id = v.entry_id
    union all
    select l.closed_at, l.closed_by, 'logbook',
      'menandai selesai catatan logbook shift ' || l.shift || ' tanggal ' || l.entry_date::text,
      left(l.body, 160)
    from logbook_entries l where l.closed_at is not null
    union all
    -- Kelola pengguna dan tindakan admin
    select a.created_at, a.actor_id, 'admin',
      case a.action
        when 'update_profile' then 'mengubah akun ' || coalesce((select p.full_name from profiles p where p.id = a.target_id), '-') || ': ' ||
             coalesce(nullif(array_to_string(array_remove(array[
               case when a.details->'old'->>'role' is distinct from a.details->'new'->>'role'
                    then 'peran ' || (a.details->'old'->>'role') || ' → ' || (a.details->'new'->>'role') end,
               case when a.details->'old'->>'department_id' is distinct from a.details->'new'->>'department_id'
                    then 'departemen ' || coalesce((select d.name from departments d where d.id = (a.details->'old'->>'department_id')::int), '-')
                         || ' → ' || coalesce((select d.name from departments d where d.id = (a.details->'new'->>'department_id')::int), '-') end,
               case when a.details->'old'->>'is_active' is distinct from a.details->'new'->>'is_active'
                    then case when (a.details->'new'->>'is_active')::boolean then 'diaktifkan' else 'dinonaktifkan' end end
             ], null), ', '), ''), 'tanpa perubahan')
        when 'delete_task_events' then 'menghapus ' || coalesce(a.details->>'count', '?') || ' log tugas'
        when 'deactivate_routine' then 'menghapus rutinitas ' || coalesce(a.details->>'name', '-')
        when 'reopen_routine_run' then 'membuka ulang isian ' || coalesce(a.details->>'template', '-') || ' periode ' || coalesce(a.details->>'period', '-')
        when 'invite_user' then 'membuat akun ' || coalesce((select p.full_name from profiles p where p.id = a.target_id), '-')
        else a.action end,
      null
    from admin_log a
    union all
    -- Ekspor laporan dan tutup bulan
    select x.created_at, x.user_id, 'export',
      'mengekspor laporan ' || x.period_start::text || ' s/d ' || x.period_end::text || ' (' || x.row_count || ' baris)', null
    from export_logs x
    union all
    select m.closed_at, m.closed_by, 'export', 'menutup bulan ' || m.period, null
    from monthly_snapshots m
  )
  select f.at, f.aid, coalesce(p.full_name, '-'), f.k, f.s, f.d
  from feed f left join profiles p on p.id = f.aid
  where (p_before is null or f.at < p_before)
    and (p_from   is null or f.at >= p_from)
    and (p_to     is null or f.at <  p_to)
    and (p_actor  is null or f.aid = p_actor)
    and (p_kind   is null or f.k = p_kind)
    and (f.k in ('task', 'routine', 'logbook') or current_app_role() = 'developer')   -- pengguna dan ekspor: khusus Developer
    and (nullif(btrim(p_search), '') is null
         or f.s ilike '%' || btrim(p_search) || '%' or f.d ilike '%' || btrim(p_search) || '%'
         or p.full_name ilike '%' || btrim(p_search) || '%')
  order by f.at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;
revoke execute on function activity_feed(timestamptz, uuid, text, timestamptz, timestamptz, text, int) from public, anon;
grant  execute on function activity_feed(timestamptz, uuid, text, timestamptz, timestamptz, text, int) to authenticated, service_role;

-- Login terakhir per akun (khusus Developer): pelengkap status online untuk akun yang perangkatnya belum memakai versi app terbaru.
create function user_last_sign_in() returns table (user_id uuid, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if current_app_role() is distinct from 'developer' then raise exception 'Khusus developer'; end if;
  return query select u.id, u.last_sign_in_at from auth.users u;
end $$;
revoke execute on function user_last_sign_in() from public, anon;
grant  execute on function user_last_sign_in() to authenticated, service_role;

-- Daftar nama akun untuk filter Log Activity (nama saja; semua akun aktif sudah saling melihat nama di log).
create function list_people() returns table (id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name from profiles p where current_app_role() is not null order by p.full_name
$$;
revoke execute on function list_people() from public, anon;
grant  execute on function list_people() to authenticated, service_role;

-- =====================================================================
-- Tambah rutinitas baru (checklist) dari aplikasi.
-- Boleh: seluruh tim ME, Developer, dan akun yang didaftarkan di app_settings 'routine_editor_ids' (daftar id; berisi id editor rutinitas).
-- Rutinitas baru memakai mesin yang sama (butir x objek, tanda tangan + foto, notifikasi, arsip). Rutinitas bawaan tidak bisa dihapus;
-- rutinitas buatan hanya bisa dihapus (dinonaktifkan) selama belum punya isian, oleh pembuatnya atau Developer.
-- =====================================================================
insert into app_settings (key, value) values ('routine_editor_ids', '[]'::jsonb) on conflict (key) do nothing;

create function can_edit_routine() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    can_fill_routine()
    or (current_app_role() is not null and exists (
          select 1 from app_settings s where s.key = 'routine_editor_ids' and s.value ? (auth.uid())::text)),
    false)
$$;

-- p_subjects: ["Pompa 1", "Pompa 2"] (boleh kosong). p_items: [{section, label, kind, unit, scope}] urut tampil.
create function create_routine(p_name text, p_frequency text, p_mode text, p_noun text, p_subjects jsonb, p_items jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_name   text := btrim(coalesce(p_name, ''));
  v_noun   text := lower(btrim(coalesce(p_noun, '')));
  v_subj   jsonb := coalesce(p_subjects, '[]'::jsonb);
  v_items  jsonb := coalesce(p_items, '[]'::jsonb);
  v_base   text;
  v_key    text;
  v_n      int := 1;
  v_id     int;
  v_sort   int;
  v_subj_n int;
  v_item_n int;
  v_subj_items int;
  v_actor  text;
  r        record;
begin
  if not can_edit_routine() then raise exception 'Hanya tim ME, editor rutinitas, dan Developer yang dapat menambah rutinitas'; end if;
  if char_length(v_name) not between 2 and 60 then raise exception 'Nama rutinitas 2 sampai 60 karakter'; end if;
  if p_frequency is null or p_frequency not in ('daily', 'weekly') then raise exception 'Frekuensi harus harian atau mingguan'; end if;
  if p_mode is null or p_mode not in ('whole', 'per_subject') then raise exception 'Cara pengisian tidak dikenal'; end if;
  if jsonb_typeof(v_subj) <> 'array' or jsonb_typeof(v_items) <> 'array' then raise exception 'Data rutinitas tidak valid'; end if;
  if exists (select 1 from routine_templates where is_active and lower(name) = lower(v_name)) then
    raise exception 'Sudah ada rutinitas bernama "%"', v_name;
  end if;
  if v_noun = '' then v_noun := 'objek'; end if;
  if char_length(v_noun) > 20 then raise exception 'Sebutan objek maksimal 20 karakter'; end if;

  v_subj_n := jsonb_array_length(v_subj);
  v_item_n := jsonb_array_length(v_items);
  if v_subj_n > 100 then raise exception 'Maksimal 100 objek'; end if;
  if v_item_n not between 1 and 80 then raise exception 'Isi 1 sampai 80 butir pemeriksaan'; end if;

  if exists (select 1 from jsonb_array_elements(v_subj) x
             where jsonb_typeof(x) <> 'string' or char_length(btrim(x #>> '{}')) not between 1 and 40) then
    raise exception 'Nama objek 1 sampai 40 karakter';
  end if;
  if (select count(distinct lower(btrim(x #>> '{}'))) from jsonb_array_elements(v_subj) x) <> v_subj_n then
    raise exception 'Nama objek tidak boleh kembar';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) x
             where jsonb_typeof(x) <> 'object'
                or char_length(btrim(coalesce(x ->> 'label', ''))) not between 1 and 160
                or coalesce(x ->> 'kind', '') not in ('check', 'check_na', 'number', 'text')
                or coalesce(x ->> 'scope', 'run') not in ('run', 'subject')
                or char_length(coalesce(x ->> 'section', '')) > 60
                or char_length(coalesce(x ->> 'unit', '')) > 12) then
    raise exception 'Ada butir yang tidak valid (nama 1 sampai 160 karakter, jenis dan cakupan harus dikenal)';
  end if;

  select count(*) into v_subj_items from jsonb_array_elements(v_items) x where coalesce(x ->> 'scope', 'run') = 'subject';
  if v_subj_n = 0 and v_subj_items > 0 then raise exception 'Butir per objek membutuhkan daftar objek'; end if;
  if v_subj_n > 0 and v_subj_items = 0 then raise exception 'Minimal satu butir harus diisi per objek'; end if;
  if p_mode = 'per_subject' and v_subj_n = 0 then raise exception 'Cara per objek membutuhkan daftar objek'; end if;
  if not exists (select 1 from jsonb_array_elements(v_items) x where x ->> 'kind' <> 'text') then
    raise exception 'Minimal satu butir yang wajib diisi (bukan hanya catatan)';
  end if;

  v_base := left(trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')), 30);
  if v_base = '' then v_base := 'rutin'; end if;
  v_key := v_base;
  while exists (select 1 from routine_templates where key = v_key) loop
    v_n := v_n + 1;
    v_key := v_base || '-' || v_n;
  end loop;

  select coalesce(max(sort), 0) + 1 into v_sort from routine_templates;
  insert into routine_templates (key, name, frequency, mode, subject_noun, sort, created_by)
  values (v_key, v_name, p_frequency, p_mode, v_noun, v_sort, auth.uid())
  returning id into v_id;

  insert into routine_subjects (template_id, key, label, sort)
  select v_id, 's' || ord, btrim(x #>> '{}'), ord::int from jsonb_array_elements(v_subj) with ordinality t(x, ord);

  insert into routine_items (template_id, section, label, kind, unit, scope, sort)
  select v_id,
         coalesce(nullif(btrim(coalesce(x ->> 'section', '')), ''), 'Umum'),
         btrim(x ->> 'label'),
         x ->> 'kind',
         case when x ->> 'kind' = 'number' then nullif(btrim(coalesce(x ->> 'unit', '')), '') end,
         coalesce(x ->> 'scope', 'run'),
         ord::int
  from jsonb_array_elements(v_items) with ordinality t(x, ord);

  -- Seluruh akun aktif (kecuali pembuat) dikabari: rutinitas baru muncul di tab Rutin
  select full_name into v_actor from profiles where id = auth.uid();
  for r in select id from profiles where is_active and id <> auth.uid() loop
    perform notify_user(r.id, 'routine', 'Rutinitas baru: ' || v_name,
      coalesce(v_actor, 'Seseorang') || ' menambahkan checklist ' || v_name || ' ('
        || case p_frequency when 'weekly' then 'mingguan' else 'harian' end || ', ' || v_item_n || ' butir).',
      null, 'routine_new:' || v_id || ':' || r.id);
  end loop;
  return v_key;
end $$;

create function deactivate_routine(p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare t routine_templates;
begin
  if not can_edit_routine() then raise exception 'Hanya tim ME, editor rutinitas, dan Developer yang dapat menghapus rutinitas'; end if;
  select * into t from routine_templates where key = p_key and is_active;
  if not found then raise exception 'Rutinitas tidak ditemukan'; end if;
  if t.created_by is null then raise exception 'Rutinitas bawaan tidak bisa dihapus'; end if;
  if t.created_by <> auth.uid() and current_app_role() is distinct from 'developer' then
    raise exception 'Hanya pembuatnya atau Developer yang dapat menghapus rutinitas ini';
  end if;
  if exists (select 1 from routine_runs where template_id = t.id) then
    raise exception 'Rutinitas ini sudah punya isian, tidak bisa dihapus';
  end if;
  update routine_templates set is_active = false where id = t.id;
  insert into admin_log (actor_id, target_id, action, details)
  values (auth.uid(), auth.uid(), 'deactivate_routine', jsonb_build_object('name', t.name));
end $$;

revoke execute on function can_edit_routine(), create_routine(text, text, text, text, jsonb, jsonb), deactivate_routine(text) from public, anon;
grant  execute on function can_edit_routine(), create_routine(text, text, text, text, jsonb, jsonb), deactivate_routine(text) to authenticated, service_role;

-- =====================================================================
-- Pencatatan ke Google Sheet dan Drive di luar tugas dan rutin (Edge Function archive-log):
--   Logbook (upsert per catatan), Riwayat Tugas (satu baris per kejadian), Pengukuran Rutin (angka dan temuan NG),
--   Foto Tugas (salinan ke Drive sebelum dihapus otomatis).
-- Pemicu hanya mencatat "ada yang perlu diekspor" di antrean; fungsi terjadwal menguras antrean (service role).
-- =====================================================================
alter table attachments
  add column drive_file_id text,
  add column drive_url     text;   -- salinan di Google Drive (diisi archive-log)

create table sheet_export_queue (
  kind      text not null check (kind in ('logbook', 'event', 'detail', 'photo')),
  ref       text not null,
  queued_at timestamptz not null default now(),
  primary key (kind, ref)
);
alter table sheet_export_queue enable row level security;   -- tanpa policy: hanya service role
revoke all on sheet_export_queue from anon, authenticated;

create function enqueue_export() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into sheet_export_queue (kind, ref) values (tg_argv[0], to_jsonb(new) ->> tg_argv[1])
  on conflict (kind, ref) do update set queued_at = now();
  return null;
end $$;

create trigger logbook_entries_export after insert or update on logbook_entries
  for each row execute function enqueue_export('logbook', 'id');
create trigger task_events_export after insert on task_events
  for each row execute function enqueue_export('event', 'id');
create trigger routine_runs_export after insert on routine_runs
  for each row execute function enqueue_export('detail', 'id');
create trigger attachments_export after insert on attachments
  for each row execute function enqueue_export('photo', 'id');

-- Hapus dari antrean hanya yang tidak berubah sejak dibaca (perubahan baru saat diproses tetap antre)
create function ack_export_queue(p_kind text, p_refs text[], p_queued_at timestamptz[]) returns void
language sql security definer set search_path = public as $$
  delete from sheet_export_queue q
  using unnest(p_refs, p_queued_at) as x(ref, queued_at)
  where q.kind = p_kind and q.ref = x.ref and q.queued_at <= x.queued_at
$$;

-- Kejadian tugas dalam bentuk baris siap tulis ke Sheet "Riwayat Tugas"
create function sheet_event_rows(p_ids bigint[])
returns table (id bigint, at timestamptz, task_no bigint, title text, actor text, kind text, change text, note text)
language sql stable security definer set search_path = public as $$
  select e.id, e.created_at, t.task_no, t.title, coalesce(p.full_name, '-'),
    case e.event_type when 'created' then 'Dibuat' when 'update' then 'Update' when 'deadline_change' then 'Ubah deadline'
                      when 'reassign' then 'Ganti PIC' when 'approval' then 'Penilaian' else e.event_type::text end,
    case e.event_type
      when 'created' then 'PIC ' || coalesce((select pp.full_name from profiles pp where pp.id = (e.new_values ->> 'pic_id')::uuid), '-')
           || ', deadline ' || coalesce(e.new_values ->> 'deadline', '-')
           || case when (e.new_values ->> 'is_urgent')::boolean then ', urgent' else '' end
      when 'update' then coalesce(nullif(array_to_string(array_remove(array[
             case when e.old_values ->> 'status' is distinct from e.new_values ->> 'status'
                  then 'status ' || act_status_label(e.old_values ->> 'status') || ' ke ' || act_status_label(e.new_values ->> 'status') end,
             case when e.old_values ->> 'progress' is distinct from e.new_values ->> 'progress'
                  then 'progres ' || (e.old_values ->> 'progress') || '% ke ' || (e.new_values ->> 'progress') || '%' end,
             case when e.old_values ->> 'is_urgent' is distinct from e.new_values ->> 'is_urgent'
                  then case when (e.new_values ->> 'is_urgent')::boolean then 'ditandai urgent' else 'urgent dicabut' end end
           ], null), ', '), ''), 'catatan')
      when 'deadline_change' then (e.old_values ->> 'deadline') || ' ke ' || (e.new_values ->> 'deadline')
      when 'reassign' then coalesce(e.old_values ->> 'pic_name', '-') || ' ke ' || coalesce(e.new_values ->> 'pic_name', '-')
      when 'approval' then act_approval_label(e.new_values ->> 'approval')
           || case when e.new_values ? 'status' and e.old_values ->> 'status' is distinct from e.new_values ->> 'status'
                   then ' (status kembali ke ' || act_status_label(e.new_values ->> 'status') || ')' else '' end
      else '' end,
    e.note
  from task_events e
  join tasks t on t.id = e.task_id
  left join profiles p on p.id = e.actor_id
  where e.id = any (p_ids)
  order by e.id
$$;

revoke execute on function enqueue_export(), ack_export_queue(text, text[], timestamptz[]), sheet_event_rows(bigint[]) from public, anon, authenticated;
grant  execute on function ack_export_queue(text, text[], timestamptz[]), sheet_event_rows(bigint[]) to service_role;

-- Foto tugas baru boleh dihapus otomatis setelah masa simpan HANYA bila sudah tersalin ke Drive
-- (atau sudah lewat 7 hari tambahan, supaya kegagalan arsip tidak membuat penyimpanan membengkak tanpa batas)
create or replace view attachments_expired as
select a.id, a.storage_path
from attachments a
where a.deleted_at is null
  and a.created_at < now() - make_interval(
        days => (select (value #>> '{}')::int from app_settings where key = 'photo_retention_days'))
  and (a.drive_url is not null
       or a.created_at < now() - make_interval(
            days => (select (value #>> '{}')::int from app_settings where key = 'photo_retention_days') + 7));
