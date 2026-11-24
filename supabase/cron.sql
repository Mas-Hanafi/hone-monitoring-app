-- Jadwal harian pembersihan foto: 20:00 UTC = 03:00 WIB.
-- Jalankan SEKALI di SQL Editor setelah function di-deploy.
-- Ganti <PROJECT_REF> dan <CRON_SECRET> (nilai sama dengan `supabase secrets set CRON_SECRET`).
-- Jangan commit file ini dengan secret asli terisi.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<CRON_SECRET>', 'cron_secret');

select cron.schedule(
  'cleanup-photos',
  '0 20 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/cleanup-photos',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Cek jalannya:   select * from cron.job_run_details order by start_time desc limit 5;
-- Hentikan:       select cron.unschedule('cleanup-photos');

-- Sinkron antrean tugas ke Google Sheet, tiap 2 menit (function: sync-sheet).
-- Pakai secret Vault 'cron_secret' yang sama; tidak perlu membuatnya lagi.
select cron.schedule(
  'sync-sheet',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-sheet',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
-- Hentikan: select cron.unschedule('sync-sheet');

-- Pengingat harian (deadline besok, terlambat, macet): 01:00 UTC = 08:00 WIB. Murni SQL, tanpa HTTP.
select cron.schedule('daily-reminders', '0 1 * * *', $$ select generate_reminders(); $$);
-- Hentikan: select cron.unschedule('daily-reminders');

-- Kirim push HP untuk notifikasi baru, tiap menit (function: send-push).
select cron.schedule(
  'send-push',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
-- Hentikan: select cron.unschedule('send-push');

-- Arsip bukti rutin ME (foto + tanda tangan) ke Google Drive dan tab "Rutin" di Sheet, tiap 5 menit (function: archive-routine).
-- Butuh secret ARCHIVE_SCRIPT_URL dan ARCHIVE_TOKEN (lihat apps-script/Code.gs) dan app_settings 'routine_drive_folder_id'.
select cron.schedule(
  'archive-routine',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/archive-routine',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
-- Hentikan: select cron.unschedule('archive-routine');

-- Catat Logbook, Riwayat Tugas, Pengukuran Rutin, dan Foto Tugas ke Google Sheet/Drive, tiap 5 menit (function: archive-log).
-- Memakai secret yang sama dengan archive-routine (SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, ARCHIVE_SCRIPT_URL, ARCHIVE_TOKEN).
select cron.schedule(
  'archive-log',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/archive-log',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
-- Hentikan: select cron.unschedule('archive-log');
