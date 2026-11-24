// Bentuk baris Sheet dan rencana tulis. Murni, tanpa import, supaya mudah dites.

export type Cell = string | number

export const HEADERS = [
  'No', 'Tugas / Project', 'Peminta', 'PIC', 'Departemen PIC', 'Progress (%)', 'Urgensi',
  'Status', 'Approval', 'Deadline', 'Mulai dikerjakan', 'Selesai', 'Keterangan / kendala', 'Update terakhir',
]

const APPROVAL: Record<string, string> = {
  pending: 'Pending', approved: 'Approve', hold: 'Hold', rejected: 'Reject',
}

const STATUS: Record<string, string> = {
  not_started: 'Belum dimulai', in_progress: 'Dikerjakan', on_hold: 'Hold',
  done: 'Selesai', handover: 'Handover', cancelled: 'Dibatalkan',
}

export interface TaskRecord {
  id: string
  task_no: number
  title: string
  status: string
  approval: string
  progress: number
  is_urgent: boolean
  deadline: string
  started_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  latest_note: string | null
  last_update_at: string
  requester: { name: string } | null
  pic: { full_name: string } | null
  dept: { name: string } | null
}

const TZ = 'Asia/Jakarta'
const day = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ }) : '')
const stamp = (iso: string): string => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ })

export function toRow(t: TaskRecord): Cell[] {
  return [
    t.task_no, t.title, t.requester?.name ?? '', t.pic?.full_name ?? '', t.dept?.name ?? '',
    t.progress, t.is_urgent ? 'Urgent' : 'Normal', STATUS[t.status] ?? t.status,
    APPROVAL[t.approval] ?? t.approval, t.deadline,
    day(t.started_at), day(t.completed_at ?? t.cancelled_at), t.latest_note ?? '', stamp(t.last_update_at),
  ]
}

const colLetter = (n: number): string => String.fromCharCode(64 + n) // n <= 26
export const quoteTab = (tab: string): string => `'${tab.replace(/'/g, "''")}'`

export interface Update { range: string; values: Cell[][] }

// colA = isi kolom A (termasuk header di baris 1). Kunci baris = nomor tugas.
export function planWrites(
  colA: unknown[][],
  records: { taskNo: number; row: Cell[] }[],
  tab: string,
): { updates: Update[]; appends: Cell[][] } {
  const rowOf = new Map<string, number>()
  colA.forEach((cells, i) => {
    const v = cells?.[0]
    if (i > 0 && v !== undefined && v !== '') rowOf.set(String(v), i + 1)
  })
  const last = colLetter(HEADERS.length)
  const updates: Update[] = []
  const appends: Cell[][] = []
  for (const r of [...records].sort((a, b) => a.taskNo - b.taskNo)) {
    const n = rowOf.get(String(r.taskNo))
    if (n) updates.push({ range: `${quoteTab(tab)}!A${n}:${last}${n}`, values: [r.row] })
    else appends.push(r.row)
  }
  return { updates, appends }
}
