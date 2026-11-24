// Edge Function terjadwal: catat Logbook, Riwayat Tugas, Pengukuran Rutin, dan Foto Tugas ke Google Sheet / Drive.
// Pemicu database mengisi antrean sheet_export_queue; fungsi ini menguras antrean (idempotent, aman dijalankan ulang).
// Deploy : supabase functions deploy archive-log --no-verify-jwt
// Secret : CRON_SECRET, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, ARCHIVE_SCRIPT_URL, ARCHIVE_TOKEN (sama dengan archive-routine)
// Config : app_settings 'routine_drive_folder_id' = folder Drive induk (foto tugas masuk ke "Foto Tugas/TSK-nnnn")
// Uji    : ?dry_run=1 (hanya menghitung antrean, tanpa Google)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { bridgeClient, getAccessToken, tabClient, type ServiceAccount } from './google.ts'
import {
  TABS, detailRows, eventRow, logbookRow, photoFolder, photoName, photoRow,
  type AnswerRecord, type EventRecord, type LogbookRecord, type PhotoRecord, type RunInfo,
} from './format.ts'

function need(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`${name} belum diisi`)
  return v
}

type QueueItem = { ref: string; queued_at: string }
const LIMITS = { logbook: 100, event: 300, detail: 3, photo: 3 }

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('unauthorized', { status: 401 })
  const dryRun = new URL(req.url).searchParams.get('dry_run') === '1'

  try {
    const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

    const queue = async (kind: keyof typeof LIMITS): Promise<QueueItem[]> => {
      const { data, error } = await sb.from('sheet_export_queue').select('ref, queued_at').eq('kind', kind).order('queued_at').limit(LIMITS[kind])
      if (error) throw new Error(`baca antrean ${kind}: ${error.message}`)
      return (data ?? []) as QueueItem[]
    }
    const ack = async (kind: string, items: QueueItem[]) => {
      if (!items.length) return
      const { error } = await sb.rpc('ack_export_queue', { p_kind: kind, p_refs: items.map((x) => x.ref), p_queued_at: items.map((x) => x.queued_at) })
      if (error) throw new Error(`ack ${kind}: ${error.message}`)
    }

    const pending = { logbook: await queue('logbook'), event: await queue('event'), detail: await queue('detail'), photo: await queue('photo') }
    const total = pending.logbook.length + pending.event.length + pending.detail.length + pending.photo.length
    if (dryRun) return Response.json({ pending: Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, v.length])) })
    const out = { logbook: 0, event: 0, detail: 0, photo: 0, errors: [] as string[] }
    if (total === 0) return Response.json(out) // tidak ada antrean: jangan sentuh Google

    const raw = need('GOOGLE_SERVICE_ACCOUNT_JSON').trim()
    const sa = JSON.parse(raw.startsWith('{') ? raw : atob(raw)) as ServiceAccount
    const token = await getAccessToken(sa)
    const sheetId = need('SHEET_ID')
    const tab = (t: { name: string; headers: readonly string[] }) => tabClient(token, sheetId, t.name, t.headers)
    const step = async (name: string, fn: () => Promise<void>) => {
      try { await fn() } catch (e) { out.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)) }
    }

    // 1. Logbook: ubah baris yang sudah ada, tambah yang baru
    await step('logbook', async () => {
      if (!pending.logbook.length) return
      const { data, error } = await sb.from('logbook_entries')
        .select('id, entry_date, shift, entry_time, body, status, created_at, updated_at, revisions, closed_at, creator:profiles!logbook_entries_created_by_fkey(full_name), updater:profiles!logbook_entries_updated_by_fkey(full_name), closer:profiles!logbook_entries_closed_by_fkey(full_name)')
        .in('id', pending.logbook.map((x) => Number(x.ref))).order('id')
      if (error) throw new Error(`baca logbook: ${error.message}`)
      const rows = ((data ?? []) as unknown as LogbookRecord[]).map(logbookRow)
      await tab(TABS.logbook).upsert(rows)
      out.logbook = rows.length
      await ack('logbook', pending.logbook)
    })

    // 2. Riwayat tugas: satu baris per kejadian
    await step('event', async () => {
      if (!pending.event.length) return
      const { data, error } = await sb.rpc('sheet_event_rows', { p_ids: pending.event.map((x) => Number(x.ref)) })
      if (error) throw new Error(`baca kejadian: ${error.message}`)
      const rows = ((data ?? []) as EventRecord[]).map(eventRow)
      out.event = await tab(TABS.events).appendNew(rows)
      await ack('event', pending.event) // termasuk kejadian yang sudah dihapus developer (tidak ada di hasil)
    })

    // 3. Pengukuran rutin: satu isian per langkah (jawaban bisa ratusan butir)
    for (const item of pending.detail) {
      await step(`detail ${item.ref}`, async () => {
        const { data: run, error: rErr } = await sb.from('routine_runs')
          .select('id, period, submitted_at, template:routine_templates(name), inspector:profiles!routine_runs_inspector_id_fkey(full_name)')
          .eq('id', item.ref).maybeSingle()
        if (rErr) throw new Error(`baca isian: ${rErr.message}`)
        if (!run) { await ack('detail', [item]); return } // isian dibuka ulang/dihapus
        const info: RunInfo = { id: run.id, period: run.period, submitted_at: run.submitted_at, template: run.template as unknown as { name: string }, inspector: (run.inspector as unknown as { full_name: string } | null)?.full_name ?? '-' }
        const answers: AnswerRecord[] = []
        for (let from = 0; from < 5000; from += 1000) {
          const { data, error } = await sb.from('routine_answers')
            .select('run_id, item_id, subject_id, status, num, note, item:routine_items(label, section, kind, unit), subject:routine_subjects(label)')
            .eq('run_id', item.ref).order('id').range(from, from + 999)
          if (error) throw new Error(`baca jawaban: ${error.message}`)
          answers.push(...((data ?? []) as unknown as AnswerRecord[]))
          if ((data ?? []).length < 1000) break
        }
        out.detail += await tab(TABS.detail).appendNew(detailRows(info, answers))
        await ack('detail', [item])
      })
    }

    // 4. Foto tugas: salin ke Drive sebelum dihapus otomatis, catat tautannya
    if (pending.photo.length) {
      const bridge = bridgeClient(need('ARCHIVE_SCRIPT_URL'), need('ARCHIVE_TOKEN'))
      const { data: cfg } = await sb.from('app_settings').select('value').eq('key', 'routine_drive_folder_id').maybeSingle()
      const rootId = typeof cfg?.value === 'string' ? cfg.value : ''
      for (const item of pending.photo) {
        await step(`foto ${item.ref}`, async () => {
          if (!rootId) throw new Error("app_settings 'routine_drive_folder_id' belum diisi")
          const { data: p, error } = await sb.from('attachments')
            .select('id, created_at, storage_path, deleted_at, drive_url, task:tasks(task_no, title), uploader:profiles!attachments_uploaded_by_fkey(full_name)')
            .eq('id', item.ref).maybeSingle()
          if (error) throw new Error(`baca foto: ${error.message}`)
          if (!p || p.deleted_at) { await ack('photo', [item]); return }
          const photo = p as unknown as PhotoRecord & { drive_url: string | null }
          let url = photo.drive_url ?? ''
          let folderUrl = ''
          if (!url) {
            const dl = await sb.storage.from('task-photos').download(photo.storage_path)
            if (dl.error || !dl.data) {
              if (/not found|does not exist/i.test(dl.error?.message ?? '')) { await ack('photo', [item]); return } // file sudah tidak ada: tidak ada yang bisa disalin
              throw new Error(`unduh ${photo.storage_path}: ${dl.error?.message ?? 'kosong'}`)
            }
            const up = await bridge.upload(rootId, photoFolder(photo), photoName(photo), new Uint8Array(await dl.data.arrayBuffer()), dl.data.type || 'image/jpeg')
            url = up.url
            folderUrl = up.folderUrl
            const { error: uErr } = await sb.from('attachments').update({ drive_file_id: up.id, drive_url: up.url }).eq('id', photo.id)
            if (uErr) throw new Error(`catat foto: ${uErr.message}`)
          }
          out.photo += await tab(TABS.photos).appendNew([photoRow(photo, url, folderUrl)])
          await ack('photo', [item])
        })
      }
    }

    console.log(JSON.stringify(out))
    return Response.json(out, { status: out.errors.length ? 207 : 200 })
  } catch (e) {
    console.error(e)
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
})
