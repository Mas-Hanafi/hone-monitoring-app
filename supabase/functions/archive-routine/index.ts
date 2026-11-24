// Edge Function terjadwal: salin bukti rutin ME (foto + tanda tangan) dari Supabase Storage ke Google Drive,
// lalu catat satu baris per isian di tab "Rutin" pada Google Sheet yang sama dengan sinkron tugas.
// Deploy : supabase functions deploy archive-routine --no-verify-jwt
// Secret : CRON_SECRET, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (sama dengan sync-sheet),
//          ARCHIVE_SCRIPT_URL + ARCHIVE_TOKEN (jembatan Apps Script: apps-script/Code.gs)
// Config : app_settings 'routine_drive_folder_id' = ID folder Drive induk (milik/dapat ditulis akun pemilik skrip)
// Uji    : ?dry_run=1 (hitung antrean, tanpa Google) dan ?probe=1 (cek izin Drive: buat folder + berkas kecil lalu hapus)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { bridgeClient, getAccessToken, sheetsClient, type ServiceAccount } from './drive.ts'
import { runArchive } from './archive.ts'
import { HEADERS, TAB, type RunRecord } from './rows.ts'

function need(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`${name} belum diisi`)
  return v
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('unauthorized', { status: 401 })
  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dry_run') === '1'
  const probe = url.searchParams.get('probe') === '1'

  try {
    const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

    const { data: cfg } = await sb.from('app_settings').select('value').eq('key', 'routine_drive_folder_id').maybeSingle()
    const rootId = typeof cfg?.value === 'string' ? cfg.value : ''
    if (!rootId && !dryRun) throw new Error("app_settings 'routine_drive_folder_id' belum diisi")

    const { count } = await sb.from('routine_runs').select('id', { count: 'exact', head: true }).is('archived_at', null)
    if (dryRun) return Response.json({ pending: count ?? 0 })
    if (!probe && (count ?? 0) === 0) return Response.json({ runs: 0, files: 0, rows: 0, errors: [] }) // tidak ada antrean: jangan sentuh Google

    const bridge = bridgeClient(need('ARCHIVE_SCRIPT_URL'), need('ARCHIVE_TOKEN'))
    if (probe) return Response.json(await bridge.ping(rootId))

    const raw = need('GOOGLE_SERVICE_ACCOUNT_JSON').trim()
    const sa = JSON.parse(raw.startsWith('{') ? raw : atob(raw)) as ServiceAccount
    const token = await getAccessToken(sa)
    const sheet = sheetsClient(token, need('SHEET_ID'), TAB, HEADERS)

    const result = await runArchive({
      async readPending(limit) {
        const { data, error } = await sb.from('routine_runs')
          .select('id, period, submitted_at, ng_count, template:routine_templates(key, name, frequency), inspector:profiles!routine_runs_inspector_id_fkey(full_name), files:routine_files(id, kind, storage_path, drive_id:drive_file_id, drive_url)')
          .is('archived_at', null).order('submitted_at').limit(limit)
        if (error) throw new Error(`baca isian: ${error.message}`)
        const runs = (data ?? []) as unknown as (Omit<RunRecord, 'inspector' | 'ngs' | 'objects'> & { inspector: { full_name: string } | null })[]
        if (runs.length === 0) return []
        const { data: ng, error: nError } = await sb.from('routine_answers')
          .select('run_id, note, item:routine_items(label), subject:routine_subjects(label)')
          .in('run_id', runs.map((r) => r.id)).eq('status', 'ng').limit(500)
        if (nError) throw new Error(`baca temuan: ${nError.message}`)
        const byRun = new Map<string, string[]>()
        for (const a of (ng ?? []) as unknown as { run_id: string; note: string | null; item: { label: string } | null; subject: { label: string } | null }[]) {
          const line = `${a.subject ? `${a.subject.label} - ` : ''}${a.item?.label ?? ''}${a.note ? `: ${a.note}` : ''}`
          byRun.set(a.run_id, [...(byRun.get(a.run_id) ?? []), line])
        }
        const { data: subj, error: sError } = await sb.from('routine_run_subjects')
          .select('run_id, subject:routine_subjects(label)').in('run_id', runs.map((r) => r.id)).limit(500)
        if (sError) throw new Error(`baca objek: ${sError.message}`)
        const objs = new Map<string, string[]>()
        for (const x of (subj ?? []) as unknown as { run_id: string; subject: { label: string } | null }[]) {
          if (x.subject) objs.set(x.run_id, [...(objs.get(x.run_id) ?? []), x.subject.label])
        }
        return runs.map((r) => ({ ...r, inspector: r.inspector?.full_name ?? '-', ngs: byRun.get(r.id) ?? [], objects: (objs.get(r.id) ?? []).sort() }))
      },
      async folderFor(run) {
        return { url: (await bridge.folder(rootId, [run.template.name, run.period])).folderUrl }
      },
      async download(path) {
        const { data, error } = await sb.storage.from('routine-files').download(path)
        if (error || !data) throw new Error(`unduh ${path}: ${error?.message ?? 'kosong'}`)
        return { bytes: new Uint8Array(await data.arrayBuffer()), type: data.type || 'application/octet-stream' }
      },
      upload: (run, name, bytes, type) => bridge.upload(rootId, [run.template.name, run.period], name, bytes, type),
      async markFile(fileId, d) {
        const { error } = await sb.from('routine_files').update({ drive_file_id: d.id, drive_url: d.url }).eq('id', fileId)
        if (error) throw new Error(`catat berkas: ${error.message}`)
      },
      sheet,
      async markRun(runId, folder) {
        const { error } = await sb.from('routine_runs').update({ archived_at: new Date().toISOString(), drive_folder_url: folder }).eq('id', runId)
        if (error) throw new Error(`catat isian: ${error.message}`)
      },
    })

    console.log(JSON.stringify(result))
    return Response.json(result, { status: result.errors.length ? 207 : 200 })
  } catch (e) {
    console.error(e)
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
})
