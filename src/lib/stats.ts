// Logika ringkasan dashboard. Fungsi murni, tanpa import runtime, supaya mudah dites.
// Ini tim ME (satu tim): ringkasan hanya angka tim + daftar tugas yang perlu perhatian.
// Tidak ada beban/kapasitas per orang.

export const STALE_DAYS = 3 // tugas aktif tanpa update lebih dari ini = macet

const DAY_MS = 86_400_000
const ACTIVE = ['not_started', 'in_progress', 'on_hold']

export interface DashTask {
  id: string
  title: string
  status: string
  progress: number
  is_urgent: boolean
  deadline: string // YYYY-MM-DD
  last_update_at: string // ISO
  pic_name: string
}

export interface Kpi { active: number; urgent: number; late: number; stale: number }
export interface AttentionRow { id: string; title: string; pic: string; reasons: string[]; score: number }
export interface Summary { kpi: Kpi; attention: AttentionRow[] }

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)

export function summarize(all: DashTask[], today: string, nowMs: number): Summary {
  const tasks = all.filter((t) => ACTIVE.includes(t.status))
  const isLate = (t: DashTask) => t.deadline < today
  const staleDays = (t: DashTask) =>
    t.status === 'on_hold' ? 0 : Math.floor((nowMs - Date.parse(t.last_update_at)) / DAY_MS)
  const isStale = (t: DashTask) => staleDays(t) > STALE_DAYS

  const kpi: Kpi = {
    active: tasks.length,
    urgent: tasks.filter((t) => t.is_urgent).length,
    late: tasks.filter(isLate).length,
    stale: tasks.filter(isStale).length,
  }

  const attention: AttentionRow[] = tasks.flatMap((t) => {
    const reasons: string[] = []
    let score = 0
    if (isLate(t)) { const d = daysBetween(t.deadline, today); reasons.push(`Terlambat ${d} hari`); score += 100 + d }
    if (isStale(t)) { const d = staleDays(t); reasons.push(`Macet ${d} hari`); score += 50 + d }
    if (!reasons.length) return []
    if (t.is_urgent) score += 20
    return [{ id: t.id, title: t.title, pic: t.pic_name, reasons, score }]
  }).sort((a, b) => b.score - a.score).slice(0, 15)

  return { kpi, attention }
}
