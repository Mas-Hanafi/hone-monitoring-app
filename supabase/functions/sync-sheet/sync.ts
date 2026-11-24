// Orkestrasi sinkron: antrean -> data tugas -> Sheet -> ack. Dependensi disuntik (mudah dites).
// Urutan penting: ack paling akhir. Kalau tulis gagal, antrean utuh dan run berikutnya mengulang.
// Kalau append sukses tapi ack gagal, run berikutnya menemukan barisnya dan meng-update
// (tidak menggandakan), karena kunci baris = nomor tugas di kolom A.
import { HEADERS, planWrites, toRow, type Cell, type TaskRecord, type Update } from './sheet.ts'

export interface OutboxItem { task_id: string; queued_at: string }

export interface Deps {
  readOutbox(limit: number): Promise<OutboxItem[]>
  fetchTasks(ids: string[]): Promise<TaskRecord[]>
  ack(items: OutboxItem[]): Promise<void>
  sheet: {
    tab: string
    readColumnA(): Promise<unknown[][]>
    writeHeader(): Promise<void>
    update(data: Update[]): Promise<void>
    append(rows: Cell[][]): Promise<void>
  }
}

export interface SyncResult { dryRun: boolean; queued: number; updated: number; appended: number }

export async function runSync(deps: Deps, { dryRun = false, batch = 200, maxBatches = 5 } = {}): Promise<SyncResult> {
  const out: SyncResult = { dryRun, queued: 0, updated: 0, appended: 0 }

  for (let i = 0; i < maxBatches; i++) {
    const items = await deps.readOutbox(batch)
    if (!items.length) break
    out.queued += items.length
    if (dryRun) break // tidak mengubah apa pun, jangan loop

    const tasks = await deps.fetchTasks(items.map((x) => x.task_id))
    let colA = await deps.sheet.readColumnA()
    if (String(colA[0]?.[0] ?? '') !== HEADERS[0]) {
      await deps.sheet.writeHeader()
      colA = [[HEADERS[0]], ...colA.slice(1)]
    }

    const plan = planWrites(colA, tasks.map((t) => ({ taskNo: t.task_no, row: toRow(t) })), deps.sheet.tab)
    if (plan.updates.length) await deps.sheet.update(plan.updates)
    if (plan.appends.length) await deps.sheet.append(plan.appends)
    await deps.ack(items)

    out.updated += plan.updates.length
    out.appended += plan.appends.length
    if (items.length < batch) break
  }
  return out
}
