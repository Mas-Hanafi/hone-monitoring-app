// Bentuk tabel laporan dari baris export_tasks / snapshot bulanan. Murni, tanpa import runtime.
import type { Cell } from './csv'

export interface ExportRow {
  task_no: number
  title: string
  requester: string
  pic: string
  pic_department: string
  status: string
  approval: string
  urgency: string
  progress_start: number | null
  progress_end: number
  original_deadline: string
  deadline: string
  assigned_on: string | null
  started_on: string | null
  completed_on: string | null
  closed_on: string | null
  last_update_on: string | null
  latest_note: string | null
}

const COLUMNS: { key: keyof ExportRow; label: string }[] = [
  { key: 'task_no', label: 'No' },
  { key: 'title', label: 'Tugas / Project' },
  { key: 'requester', label: 'Peminta' },
  { key: 'pic', label: 'PIC' },
  { key: 'pic_department', label: 'Departemen PIC' },
  { key: 'status', label: 'Status' },
  { key: 'approval', label: 'Approval' },
  { key: 'urgency', label: 'Urgensi' },
  { key: 'progress_start', label: 'Progress awal periode (%)' },
  { key: 'progress_end', label: 'Progress akhir periode (%)' },
  { key: 'original_deadline', label: 'Deadline awal' },
  { key: 'deadline', label: 'Deadline' },
  { key: 'assigned_on', label: 'Tanggal ditugaskan' },
  { key: 'started_on', label: 'Mulai dikerjakan' },
  { key: 'completed_on', label: 'Selesai' },
  { key: 'closed_on', label: 'Ditutup' },
  { key: 'last_update_on', label: 'Update terakhir' },
  { key: 'latest_note', label: 'Keterangan / kendala' },
]

export interface Table { headers: string[]; body: Cell[][] }

export function rowsToTable(rows: ExportRow[], statusLabel: Record<string, string>): Table {
  return {
    headers: COLUMNS.map((c) => c.label),
    body: rows.map((r) =>
      COLUMNS.map((c) => (c.key === 'status' ? (statusLabel[r.status] ?? r.status) : (r[c.key] as Cell))),
    ),
  }
}

const ACTIVE = ['not_started', 'in_progress', 'on_hold']
const FINISHED = ['done', 'handover']

export interface Counts { total: number; finished: number; active: number; cancelled: number; urgent: number; late: number }

// Keadaan di akhir periode. Terlambat = masih aktif dan deadline sebelum hari terakhir periode.
export function countRows(rows: ExportRow[], periodEnd: string): Counts {
  return {
    total: rows.length,
    finished: rows.filter((r) => FINISHED.includes(r.status)).length,
    active: rows.filter((r) => ACTIVE.includes(r.status)).length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    urgent: rows.filter((r) => r.urgency === 'Urgent').length,
    late: rows.filter((r) => ACTIVE.includes(r.status) && r.deadline < periodEnd).length,
  }
}

export function buildRecap(rows: ExportRow[], periodEnd: string): Table {
  const groups = new Map<string, ExportRow[]>()
  for (const r of rows) {
    const key = `${r.pic}\u0000${r.pic_department}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const body = [...groups.values()]
    .sort((a, b) => a[0].pic.localeCompare(b[0].pic))
    .map((list): Cell[] => {
      const c = countRows(list, periodEnd)
      const avg = Math.round(list.reduce((s, r) => s + r.progress_end, 0) / list.length)
      return [list[0].pic, list[0].pic_department, c.total, c.finished, c.active, c.cancelled, c.urgent, c.late, avg]
    })
  return {
    headers: ['PIC', 'Departemen', 'Total tugas', 'Selesai', 'Aktif', 'Dibatalkan', 'Urgent', 'Terlambat', 'Rata-rata progress (%)'],
    body,
  }
}
