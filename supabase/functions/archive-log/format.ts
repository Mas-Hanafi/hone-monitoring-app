// Bentuk baris Sheet untuk pencatatan Logbook, Riwayat Tugas, Pengukuran Rutin, dan Foto Tugas. Murni, tanpa import.
// Semua nilai ditulis ke Sheet dengan mode RAW (tidak pernah dijalankan sebagai rumus).

export type Cell = string | number

export const TABS = {
  logbook: {
    name: 'Logbook',
    headers: ['ID', 'Tanggal', 'Shift', 'Jam', 'Kegiatan', 'Status', 'Dicatat oleh', 'Dicatat (WIB)', 'Terakhir diubah oleh', 'Diubah (WIB)', 'Jumlah revisi', 'Diselesaikan oleh', 'Diselesaikan (WIB)'],
  },
  events: {
    name: 'Riwayat Tugas',
    headers: ['ID log', 'Waktu (WIB)', 'No tugas', 'Tugas', 'Pelaku', 'Jenis', 'Perubahan', 'Catatan'],
  },
  detail: {
    name: 'Pengukuran Rutin',
    headers: ['Kunci', 'Periode', 'Checklist', 'Pengisi', 'Dikirim (WIB)', 'Objek', 'Bagian', 'Butir', 'Hasil', 'Angka', 'Satuan', 'Catatan'],
  },
  photos: {
    name: 'Foto Tugas',
    headers: ['ID foto', 'Diunggah (WIB)', 'No tugas', 'Tugas', 'Diunggah oleh', 'Foto (Drive)', 'Folder Drive'],
  },
} as const

const TZ = 'Asia/Jakarta'
export const stamp = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }) : '')
const hhmm = (t: string | null): string => (t ? t.slice(0, 5) : '')
export const tsk = (n: number): string => `TSK-${String(n).padStart(4, '0')}`

// Hanya tautan Drive resmi yang boleh masuk ke Sheet
export function link(url: string | null | undefined): string {
  return url && /^https:\/\/drive\.google\.com\/[A-Za-z0-9_\-/.?=&%]+$/.test(url) ? url : ''
}

// ---- Logbook ----
export interface LogbookRecord {
  id: number; entry_date: string; shift: string; entry_time: string | null; body: string; status: string
  created_at: string; updated_at: string | null; revisions: number; closed_at: string | null
  creator: { full_name: string } | null; updater: { full_name: string } | null; closer: { full_name: string } | null
}
const SHIFT: Record<string, string> = { morning: 'Morning', evening: 'Evening', night: 'Night' }

export function logbookRow(e: LogbookRecord): Cell[] {
  return [
    e.id, e.entry_date, SHIFT[e.shift] ?? e.shift, hhmm(e.entry_time), e.body,
    e.status === 'open' ? 'Perlu dilanjutkan' : 'Selesai',
    e.creator?.full_name ?? '-', stamp(e.created_at),
    e.updater?.full_name ?? '', stamp(e.updated_at), e.revisions,
    e.closer?.full_name ?? '', stamp(e.closed_at),
  ]
}

// ---- Riwayat Tugas (baris sudah dirumuskan di database: fungsi sheet_event_rows) ----
export interface EventRecord { id: number; at: string; task_no: number; title: string; actor: string; kind: string; change: string; note: string | null }
export function eventRow(r: EventRecord): Cell[] {
  return [r.id, stamp(r.at), tsk(r.task_no), r.title, r.actor, r.kind, r.change, r.note ?? '']
}

// ---- Pengukuran Rutin: angka (butir jenis angka) dan semua temuan NG ----
export interface AnswerRecord {
  run_id: string; item_id: number; subject_id: number | null; status: 'ok' | 'ng' | 'na'; num: number | null; note: string | null
  item: { label: string; section: string; kind: string; unit: string | null } | null
  subject: { label: string } | null
}
export interface RunInfo { id: string; period: string; submitted_at: string; template: { name: string }; inspector: string }

export const isMeasured = (a: AnswerRecord): boolean => a.item?.kind === 'number' || a.status === 'ng'

export function detailRows(run: RunInfo, answers: AnswerRecord[]): Cell[][] {
  return answers.filter(isMeasured).map((a) => [
    `${run.id}|${a.item_id}|${a.subject_id ?? 0}`, run.period, run.template.name, run.inspector, stamp(run.submitted_at),
    a.subject?.label ?? '', a.item?.section ?? '', (a.item?.label ?? '').replace(' | ', ' '),
    a.status === 'ng' ? 'NG' : a.status === 'na' ? 'N/A' : 'OK',
    a.num ?? '', a.item?.kind === 'number' ? a.item.unit ?? '' : '', a.note ?? '',
  ])
}

// ---- Foto Tugas ----
export interface PhotoRecord {
  id: string; created_at: string; storage_path: string
  task: { task_no: number; title: string } | null; uploader: { full_name: string } | null
}
export const photoFolder = (p: PhotoRecord): string[] => ['Foto Tugas', p.task ? tsk(p.task.task_no) : 'tanpa-tugas']
export function photoName(p: PhotoRecord): string {
  const d = new Date(p.created_at)
  const day = d.toLocaleDateString('sv-SE', { timeZone: TZ })
  const time = d.toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).replace(':', '')
  const ext = (p.storage_path.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  return `${p.task ? tsk(p.task.task_no) : 'tugas'}_${day}_${time}_${p.id.slice(0, 8)}.${ext}`
}
export function photoRow(p: PhotoRecord, fileUrl: string, folderUrl: string): Cell[] {
  return [p.id, stamp(p.created_at), p.task ? tsk(p.task.task_no) : '', p.task?.title ?? '', p.uploader?.full_name ?? '-', link(fileUrl), link(folderUrl)]
}

// ---- Rencana tulis: ubah baris yang ada (berdasarkan ID di kolom A), tambah yang baru ----
const colLetter = (n: number): string => {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}
export const quoteTab = (tab: string): string => `'${tab.replace(/'/g, "''")}'`

export function planUpsert(colA: unknown[][], rows: Cell[][], tab: string, width: number): { updates: { range: string; values: Cell[][] }[]; appends: Cell[][] } {
  const rowOf = new Map<string, number>()
  colA.forEach((cells, i) => {
    const v = cells?.[0]
    if (i > 0 && v !== undefined && v !== '') rowOf.set(String(v), i + 1)
  })
  const last = colLetter(width)
  const updates: { range: string; values: Cell[][] }[] = []
  const appends: Cell[][] = []
  for (const r of rows) {
    const n = rowOf.get(String(r[0]))
    if (n) updates.push({ range: `${quoteTab(tab)}!A${n}:${last}${n}`, values: [r] })
    else appends.push(r)
  }
  return { updates, appends }
}
