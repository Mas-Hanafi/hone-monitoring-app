# H One monitoring app

A mobile-first web app for tracking work in a hospitality operation: who owes what, by when, how far along it is, and who signed it off. It also runs the recurring inspection checklists and the shift logbook for the engineering team.

It was built for a resort operations team and has been used in the field. This repository is the cleaned version, with the company's name, contacts and accounts replaced by placeholders.

## What it does

- Tasks with a requesting department, a person in charge, a deadline, a priority and a progress value. Progress updates carry notes and photos, a manager can approve, hold or reject the result, and every change goes into an append-only activity log.
- Routine checklists that repeat daily or weekly. A checklist can cover one object per item (a room, a panel, a generator), mark each item OK or not good, collect photos, and end with a signature drawn on screen.
- A shift logbook (morning, evening, night) that doubles as a handover note. Two people editing the same entry get a conflict warning instead of silently overwriting each other.
- A dashboard with tiles for overdue and stalled tasks, and a breakdown of in progress, not started, on hold and finished work by requesting department.
- Reports as CSV for any date range up to 366 days, as A4 PDFs on company letterhead, and as a monthly closing that freezes the figures as they stood on the last day of the month.
- Push notifications for overdue tasks and for tasks with no update for more than three days, sent to the person in charge and the supervisor.
- Offline use. Progress updates and photos queue in IndexedDB while the phone has no signal and send when it comes back, without creating duplicates.
- Four roles (staff, supervisor, manager, developer) enforced by Postgres row level security, not by the interface. Users join by email invitation or through a bulk SQL script.
- An optional sync of task data to a Google Sheet, and an Apps Script that stores routine photo evidence in a Google Drive folder.

## Stack

| Layer | Tools |
|---|---|
| App | React 19, TypeScript, Vite 8, installable PWA through `vite-plugin-pwa`, jsPDF for reports |
| Backend | Supabase: Postgres with row level security, Storage, Auth, Realtime, `pg_cron`, `pg_net`, Vault |
| Edge functions (Deno) | `invite-user`, `set-password`, `send-push`, `sync-sheet`, `archive-log`, `archive-routine`, `cleanup-photos` |
| Hosting | Cloudflare Workers with static assets (`deploy/wrangler.jsonc`) |
| Tests | Node test scripts that run the real schema inside an in-process Postgres (PGlite) |

The database carries most of the logic. `schema.sql` is about 2,000 lines: tables, policies, and the SQL functions that move a task through its states, close a month, generate reminders and queue notifications. The React code asks those functions for results instead of recomputing them.

## Layout

```
src/
  pages/          Tasks, Routine, Logbook, Reports, Dashboard, Users, Activity
  components/     task and routine sheets, signature pad, sync banner
  lib/            offline queue (IndexedDB), PDF report, auth, realtime
schema.sql        tables, policies, functions
supabase/
  functions/      the seven edge functions
  cron.sql        scheduled jobs
  bulk_users.sql  create many accounts at once (sample addresses only)
apps-script/      Google Apps Script for Drive uploads
tests/            14 test files
DEPLOY.md         step by step deploy guide (Indonesian)
```

## Run it

You need Node 22 or newer.

```bash
npm ci
npm test          # 14 files, 597 checks, no Supabase account needed
npm run build
```

To run the app itself you need a Supabase project. Copy `.env.example` to `.env.local`, fill in the project URL, the anon key and a VAPID public key, then run `npm run dev`. `DEPLOY.md` walks through the whole setup: schema, auth settings, the first developer account, edge functions, cron jobs and the Google Sheet sync.

## Placeholders to replace

| Placeholder | Where |
|---|---|
| `H ONE`, `(HOSPITALITY)`, `hello@hone.example`, `Jalan Contoh` | PDF letterhead constants at the top of `src/lib/pdfReport.ts` |
| `YOUR-PROJECT-REF` | Content Security Policy in `public/_headers` |
| `GANTI_DENGAN_ID_FOLDER_DRIVE` | Drive folder id in `apps-script/Code.gs` |
| `manager1@contoh.com` and similar | sample accounts in `supabase/bulk_users.sql` |

The logo, the letterhead image and the app icons are text placeholders. Replace the files in `public/` and `src/assets/kop/`.

## Status and limits

- The schema was installed on a real Supabase project and checked there with database level and HTTP level scripts. `DEPLOY.md` lists them.
- Not tested on real hardware or services: push delivery to phones (iPhone in particular), invitation emails, writing to Google Sheets, and the offline queue on an actual iPhone.
- The offline queue sends only while the app is open. There is no background sync.
- The deploy guide and the interface are in Indonesian.
