// Edge Function terjadwal: kuras antrean sheet_outbox dan tulis tugas ke Google Sheet (satu arah).
// Deploy : supabase functions deploy sync-sheet --no-verify-jwt
// Secret : CRON_SECRET, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (JSON mentah atau base64), SHEET_TAB (opsional, default "Tugas")
// Uji    : POST ...?dry_run=1 dengan header x-cron-secret (hanya menghitung antrean)
// Dipicu pg_cron lewat supabase/cron.sql. Sheet adalah SALINAN BACA-SAJA; edit manual akan ditimpa.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { getAccessToken, sheetClient, type ServiceAccount } from './google.ts'
import { runSync } from './sync.ts'
import type { TaskRecord } from './sheet.ts'

const SELECT =
  'id, task_no, title, status, approval, progress, is_urgent, deadline, started_at, completed_at, cancelled_at, ' +
  'latest_note, last_update_at, requester:departments!tasks_requester_department_id_fkey(name), ' +
  'pic:profiles!tasks_pic_id_fkey(full_name), dept:departments!tasks_pic_department_id_fkey(name)'

function need(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`${name} belum diisi`)
  return v
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('unauthorized', { status: 401 })
  }
  const dryRun = new URL(req.url).searchParams.get('dry_run') === '1'

  try {
    const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const raw = need('GOOGLE_SERVICE_ACCOUNT_JSON').trim()
    const sa = JSON.parse(raw.startsWith('{') ? raw : atob(raw)) as ServiceAccount
    // Dry run tidak menyentuh Google sama sekali
    const sheet = dryRun
      ? ({ tab: '', readColumnA: async () => [], writeHeader: async () => {}, update: async () => {}, append: async () => {} })
      : sheetClient(await getAccessToken(sa), need('SHEET_ID'), Deno.env.get('SHEET_TAB') ?? 'Tugas')

    const result = await runSync({
      sheet,
      async readOutbox(limit) {
        const { data, error } = await sb.from('sheet_outbox').select('task_id, queued_at').order('queued_at').limit(limit)
        if (error) throw new Error(`baca antrean: ${error.message}`)
        return data
      },
      async fetchTasks(ids) {
        const { data, error } = await sb.from('tasks').select(SELECT).in('id', ids)
        if (error) throw new Error(`baca tugas: ${error.message}`)
        return data as unknown as TaskRecord[]
      },
      async ack(items) {
        const { error } = await sb.rpc('ack_sheet_outbox', {
          p_task_ids: items.map((x) => x.task_id),
          p_queued_at: items.map((x) => x.queued_at),
        })
        if (error) throw new Error(`ack antrean: ${error.message}`)
      },
    }, { dryRun })

    console.log(JSON.stringify(result))
    return Response.json(result)
  } catch (e) {
    console.error(e)
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
})
