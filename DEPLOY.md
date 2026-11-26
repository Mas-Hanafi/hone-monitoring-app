# Deployment Guide

The order is deliberate: the frontend first (so the app's address is known), then the functions that need that address.
Run every command from the project folder. Allow roughly 1–2 hours in total, mostly filling in dashboard settings.

The app's interface is in Indonesian. Menu and button names below are given as they appear in the app, with an English gloss.

## 0. Prerequisites

- Node.js 22 or newer, a GitHub account, a Supabase account, a Cloudflare account, a Google account (for the Sheet).
- Check that the code is healthy before you start:

```bash
npm install
npm test
```

`npm test` runs 597 checks across 14 files (the schema on a local Postgres, the invite function, Sheet sync, photo deletion, dashboard counts, CSV and reports, the offline queue, notifications and push). All of them must pass.
This does not replace testing on a real Supabase project (step 9).

## 1. Create the Supabase project

1. supabase.com → New project. **Region: Singapore** (closest to Indonesia). Save the database password.
2. Use the **Pro plan before real data goes in**. The free plan has no automatic daily backups, and the activity log is the core of this app. Check Supabase's pricing page for current details.
3. Note three values from Project Settings → API:
   - **Project URL** → used as `VITE_SUPABASE_URL`
   - **publishable / anon key** → `VITE_SUPABASE_ANON_KEY`
   - **Project ref** (the first part of the URL, `xxxx` in `https://xxxx.supabase.co`)
4. **Never** put the *service role key* in the frontend, in Git, or in a chat.

## 2. Install the schema

1. Dashboard → SQL Editor → New query → paste the whole of [schema.sql](schema.sql) → Run.
2. Dashboard → Database → Extensions: enable **pg_cron** and **pg_net** (used in step 7). The **vault** extension is usually already on.
3. Check the result (there must be 13 department rows and a private `task-photos` bucket):

```sql
select count(*) from departments;
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'task-photos';
```

`schema.sql` is only for an **empty** project; running it twice fails because the types and tables already exist.
For schema changes after this, write a separate migration file (do not edit the schema and run it again).

## 3. Deploy the frontend (Cloudflare)

1. Put the code on GitHub:

```bash
git init
git add .
git commit -m "feat: aplikasi monitoring tugas"
```

Create a **private** repository on GitHub, then `git remote add origin ...` and `git push -u origin main`.
`.gitignore` already excludes `.env*`, `node_modules`, `dist`, and Google key files.

2. Cloudflare dashboard → Workers & Pages → create a project from that GitHub repository. Build settings:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `NODE_VERSION` = `22`
3. When the build finishes, note the app's address (for example `https://tugas.pages.dev` or your own domain). It is called **APP_URL** below.

You can try it locally first if you like: copy `.env.example` to `.env.local`, fill it in, then run `npm run dev`.

## 4. Supabase Auth settings

Menu names can differ slightly between dashboard versions; what matters is the result:

| Setting | Value |
|---|---|
| Self sign-up | **Off.** Accounts are only created by a Developer through an invitation |
| Site URL | APP_URL |
| Redirect URLs | APP_URL (without it, invitation and password reset links are rejected) |
| Minimum password length | 8 or more (the app also requires at least 8) |
| SMTP | **Set up your own SMTP** (Authentication → SMTP). The built-in SMTP is heavily rate limited per hour; inviting dozens of people will fail |

Invitations still work with self sign-up turned off.

## 5. The first Developer account

1. Dashboard → Authentication → Users → Add user: enter an email and password, tick **Auto Confirm User**.
2. Open [supabase/seed_developer.sql](supabase/seed_developer.sql), change the email and name, and run it in the SQL Editor.
3. The script's last result must be 1 row with the role `developer`.
4. Open APP_URL and sign in with that account. The **Pengguna** (Users) tab must appear.

## 6. Deploy the Edge Functions

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
```

Generate one random string as `CRON_SECRET` (used by the scheduled triggers; keep it in a password manager):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the secrets. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically, so you do not need to set them.

```bash
npx supabase secrets set CRON_SECRET=<random-value> APP_URL=<APP_URL>
```

Deploy the functions:

```bash
npx supabase functions deploy invite-user
npx supabase functions deploy cleanup-photos --no-verify-jwt
npx supabase functions deploy sync-sheet --no-verify-jwt
npx supabase functions deploy send-push --no-verify-jwt
```

### Phone notifications (web push)

In-app notifications (the bell) work right away. Push to the phone screen needs a VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

- **Public key** → the frontend build variable `VITE_VAPID_PUBLIC_KEY` (in Cloudflare, then redeploy the frontend).
- **Private key** → a Supabase secret only; never send it to anyone:

```bash
npx supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:<your-email>
```

Do not change these keys after staff have turned on push; their old subscriptions stop working and they have to turn push on again.
On iPhone, push only works for an app that has been added to the Home Screen (iOS 16.4 and later).

`send-push` is called every minute by the schedule (step 7). `invite-user` verifies the caller's JWT and only serves Developers. The other functions skip JWT checks because they are called on a schedule; they are protected by the `x-cron-secret` header.

## 7. Scheduled jobs (pg_cron)

1. Open [supabase/cron.sql](supabase/cron.sql). Replace `<PROJECT_REF>` (two places) and `<CRON_SECRET>` (one place, exactly the same as in step 6). **Do not commit that file with the secret filled in**; after running it, put the placeholder back.
2. Run the whole file in the SQL Editor. The `vault.create_secret` line must only be run **once** (secret names must be unique).
3. Test without any side effects (it only counts):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/cleanup-photos?dry_run=1" -H "x-cron-secret: <CRON_SECRET>"
```

The correct result: the JSON `{"dryRun":true,"expired":0,"orphans":0,"orphansSkipped":false}`. An `unauthorized` reply means the secret does not match.

4. Check reminders and push (after the `daily-reminders` and `send-push` blocks in cron.sql have been run too):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/send-push?dry_run=1" -H "x-cron-secret: <CRON_SECRET>"
```

The correct result: `{"dryRun":true,"waiting":0}` (the number matches the notifications not yet pushed).

5. Watch the schedule run:

```sql
select jobname, status, start_time, return_message
from cron.job_run_details order by start_time desc limit 10;
```

## 8. Sync to Google Sheets

1. Google Cloud Console: create a project → enable the **Google Sheets API** → IAM → Service Accounts → create one → Keys → Add key (JSON). Keep that file outside the project folder.
2. Create a **new** spreadsheet (do not reuse an old one; columns A–N will be overwritten). Share it with the service account email (`...iam.gserviceaccount.com`) as an **Editor**. Note the sheet ID (the part between `/d/` and `/edit` in the URL).
3. Convert the JSON key into single-line base64:

```bash
base64 -w0 kunci.json
```

(PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("kunci.json"))`)

4. Set the secrets, then **delete the key file**:

```bash
npx supabase secrets set SHEET_ID=<sheet-id> GOOGLE_SERVICE_ACCOUNT_JSON=<base64-value>
```

`SHEET_TAB` is optional (default `Tugas`).

5. Test: `?dry_run=1` on `sync-sheet` (same as the curl above) must return a `"queued"` count matching the number of tasks not yet synced. Create one task in the app, wait up to 2 minutes, and the row must appear in the Sheet.

The Sheet is a **read-only copy**. Manual edits in the Sheet are overwritten by the next sync. It contains employee performance data: share it only with people who are entitled to see it.

## 9. Smoke test in the real environment

Part of this is already tested automatically on a real Supabase project (see section 12). The checks below test the full flow through the app and real devices. Create 4 test accounts from the Pengguna (Users) tab (Staff in department A, SPV in A, Staff in department B, Manager), then check:

| Check | Correct result |
|---|---|
| The invitation reaches the email, and the link opens the "Atur kata sandi" (set password) screen | Yes |
| Staff A only sees their own tasks | Yes |
| SPV A does not see department B's tasks | Yes |
| An SPV creates a task for Staff B | Rejected (message "hanya… departemennya", only their own department) |
| Staff change a status without a photo | Rejected |
| Staff change a status with a photo | Succeeds; the photo appears in the Storage bucket `task-photos/<task-id>/` |
| Staff submit Done, the SPV rates it Reject with a note | The task goes back to Dikerjakan (in progress) |
| A Manager opens the Ringkasan (Summary) tab | Six number tiles appear, plus a "Perlu perhatian" (needs attention) list of late/stuck tasks |
| A new task appears in the Google Sheet | Within about 2 minutes |
| A test account is deactivated from the Pengguna tab | That account immediately sees no data at all |
| **Offline:** open the app once with signal, turn signal off (airplane mode), open it again | The app opens and the task list shows with the note "Offline: data terakhir dimuat…" (offline: last loaded data) |
| **Offline:** in airplane mode, report progress with a photo | The sheet closes, the card is marked "Menunggu terkirim" (waiting to send), and the banner shows the number of pending updates |
| **Notifications:** an SPV creates a task for Staff A | Staff A's bell goes up by 1 (within about 1 minute); Staff A works the task and submits Done → the SPV and Manager get "Menunggu penilaian" (awaiting review) |
| **Phone push:** Staff A opens the bell → turns on phone notifications → allows them; closes the app; an SPV creates a new task | A notification appears on the phone screen within about 1 minute; tapping it opens the app |
| **Phone push:** Staff A signs out, an SPV creates a task for Staff A | No push reaches that phone |
| **Offline:** turn the signal back on | Within about 30 seconds the banner disappears, events and photos appear on the server, and there are no duplicate events |
| Sign out while updates are still pending | A warning appears; the updates are sent when the same account signs in again |

Photos: upload from a real phone. Make sure the file size is small (about 300 KB) and the camera opens directly.
When you are done, deactivate the test accounts (do not delete them; deleting breaks the log history).

## 10. Operations

| Task | How |
|---|---|
| Change how long photos are kept (default 3 days) | `update app_settings set value = '14' where key = 'photo_retention_days';` |
| Require / relax photos on status changes | `update app_settings set value = 'false' where key = 'photo_required_on_status_change';` |
| An employee leaves | Pengguna (Users) tab → edit → deactivate the account. Do not delete it |
| Forgotten password | The "Lupa kata sandi" (forgot password) button on the login page |
| Close the month (frozen summary) | **Laporan** (Reports) tab → Tutup bulan (close month) (Manager/Developer, after the month ends; cannot be undone). Not possible from the SQL Editor because it needs a Manager login |
| CSV export | **Laporan** (Reports) tab → choose a date range (from–to, at most 366 days) or monthly → load the report → download the details or the per-person summary. Every loaded page is recorded in `export_logs` |
| Rotate secrets | `npx supabase secrets set ...` again, then update the `cron_secret` secret in Vault (the Vault syntax has not been tested; check the Supabase docs) |
| Check the schedule | Query `cron.job_run_details` as in step 7 |
| Run reminders now (testing) | `select generate_reminders();` in the SQL Editor (safe to repeat, does not duplicate) |
| Notifications do not show up as push | Check `send-push?dry_run=1`; make sure the device has push turned on; users without a subscription still get notifications in the bell |

## 11. Common problems

| Symptom | Likely cause |
|---|---|
| Login screen: "Email atau kata sandi salah" (wrong email or password) for a new account | The invitation has not been opened / the password has not been set |
| The invitation link is "expired" or rejected | The Redirect URL / Site URL is not set (step 4), or the link is past its expiry |
| Invitation fails with 502 | The built-in SMTP email limit; set up your own SMTP |
| After signing in: "akun belum aktif atau belum punya profil" (account not active or has no profile) | The profile has not been created, or `is_active = false` |
| `invite-user` fails with CORS in the browser | `APP_URL` is not set or does not match the app's address |
| The Sheet stays empty | Check `cron.job_run_details`; call `sync-sheet?dry_run=1`; make sure the sheet is shared with the service account email as an Editor |
| `sync-sheet` 500 "baca Sheet: HTTP 403" (reading the Sheet failed) | The Sheets API is not enabled or the sheet has not been shared |
| Photos are not deleted | Check `cleanup-photos?dry_run=1`; check `app_settings.photo_retention_days` |

## 12. Not built yet / not tested yet

- **Already tested on a real Supabase project (8 Nov 2026, project "H One Monitoring App", Singapore region):**
  - `schema.sql` installs without errors.
  - 64 database-level checks with real `anon` and `authenticated` roles: permissions, RLS, Storage policies, new tables/functions are not opened automatically, append-only tables.
  - 46 checks over HTTP with a real email + password login: queries exactly as the UI runs them (including the embed `pic:profiles!tasks_pic_id_fkey(...)`), the Storage API (1.5 MB limit, jpeg/webp only, signed URLs, other staff rejected), and every RPC.
  - All four Edge Functions deploy and run on Deno (including `npm:web-push`); without the secret they answer 401.
  - `pg_cron`, `pg_net`, and Vault are available and the syntax is correct (`cron.schedule`, `vault.create_secret`, `net.http_post` with `timeout_milliseconds`).
  - The test data has been deleted. Two small test files are still in the `task-photos` bucket (Storage cannot be deleted through SQL); `cleanup-photos` removes them automatically after more than 1 day.
- **Still untested:** real push delivery, invitation emails, writing to Google Sheets, the live cron schedule, the frontend in a browser/on a phone, and everything that needs a secret (CRON_SECRET, VAPID, Google, APP_URL).
- Offline queue: the logic is tested (24 checks), but IndexedDB storage, session recovery when the token expires without signal, and iPhone behavior have not been tested on a real device. Sending only happens while the app is open (no background sync).
- Notifications: the database logic and sending are tested (about 60 checks), but `npm:web-push` in Supabase's Deno runtime, receiving push on a real phone (especially iPhone), and opening the app by tapping a notification have not been tested. There is no "workload too high" notification yet (the workload formula has not been decided); there is no email.
- Not built yet: an in-app camera (photos are taken through the phone's camera input, and the gallery can still be chosen).
- `npm:web-push` loads in Deno, but `sendNotification` has never been run against a real push service.
- **Photos cannot be viewed in the app yet.** Photos are uploaded and stored (the Storage policies are proven correct), but there is no screen that shows them to SPVs/Managers. For now, photos can only be checked through the Supabase dashboard.
- The installed packages are newer than usual (Vite 8, TypeScript 7, vite-plugin-pwa 2); `npm run build` passes, but watch for warnings during `npm run dev`.
