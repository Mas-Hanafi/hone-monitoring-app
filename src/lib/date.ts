// Tanggal hari ini di WIB sebagai YYYY-MM-DD (sama dengan batas periode di database)
export function todayWib(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' })
}

const DAY_MS = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export function addDaysStr(date: string, n: number): string {
  return iso(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS)
}

// Minggu kalender Senin-Minggu yang memuat tanggal itu
export function weekRange(date: string): { start: string; end: string } {
  const t = Date.parse(`${date}T00:00:00Z`)
  const sinceMonday = (new Date(t).getUTCDay() + 6) % 7
  return { start: iso(t - sinceMonday * DAY_MS), end: iso(t + (6 - sinceMonday) * DAY_MS) }
}

// Bulan kalender dari 'YYYY-MM' (jumlah hari menyesuaikan bulan, termasuk Februari kabisat)
export function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number)
  return { start: `${ym}-01`, end: iso(Date.UTC(y, m, 0)) }
}

export function prevMonth(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
