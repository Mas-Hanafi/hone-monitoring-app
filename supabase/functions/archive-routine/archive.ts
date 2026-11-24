// Inti arsip: salin berkas bukti rutin (foto + tanda tangan) ke Google Drive lalu catat satu baris per isian di Sheet.
// Semua ketergantungan (Supabase, Drive, Sheets) disuntikkan supaya bisa diuji tanpa jaringan.
import { buildRow, extOf, fileName, type RunRecord } from './rows.ts'

export interface Deps {
  readPending(limit: number): Promise<RunRecord[]>
  folderFor(run: RunRecord): Promise<{ url: string }>
  download(path: string): Promise<{ bytes: Uint8Array; type: string }>
  upload(run: RunRecord, name: string, bytes: Uint8Array, type: string): Promise<{ id: string; url: string }>
  markFile(fileId: number, drive: { id: string; url: string }): Promise<void>
  sheet: { existingIds(): Promise<Set<string>>; append(rows: string[][]): Promise<void> }
  markRun(runId: string, folderUrl: string): Promise<void>
}

export interface Result { runs: number; files: number; rows: number; errors: string[] }

export async function runArchive(d: Deps, limit = 3): Promise<Result> {
  const out: Result = { runs: 0, files: 0, rows: 0, errors: [] }
  const pending = await d.readPending(limit)
  if (pending.length === 0) return out
  const known = await d.sheet.existingIds()

  for (const run of pending) {
    try {
      const folder = await d.folderFor(run)
      let photoNo = 0
      for (const f of run.files) {
        if (f.kind === 'photo') photoNo++
        if (f.drive_url) continue // sudah tersalin pada percobaan sebelumnya
        const { bytes, type } = await d.download(f.storage_path)
        const drive = await d.upload(run, fileName(run, f, photoNo, extOf(type, f.storage_path)), bytes, type)
        await d.markFile(f.id, drive)
        f.drive_url = drive.url
        f.drive_id = drive.id
        out.files++
      }
      if (!known.has(run.id)) {
        await d.sheet.append([buildRow(run, folder.url)])
        known.add(run.id)
        out.rows++
      }
      await d.markRun(run.id, folder.url)
      out.runs++
    } catch (e) {
      // satu isian gagal tidak menghentikan yang lain; dicoba lagi pada jalan berikutnya
      out.errors.push(`${run.id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
    }
  }
  return out
}
