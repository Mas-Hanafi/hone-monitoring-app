import { useCallback, useEffect, useState } from 'react'
import { addDaysStr, todayWib } from './date'
import { supabase } from './supabase'
import { useRealtime } from './realtime'

export type ShiftKey = 'morning' | 'evening' | 'night'
export type Status = 'done' | 'open'
export type Entry = {
  id: number; entry_date: string; shift: ShiftKey; entry_time: string | null; body: string; status: Status
  created_by: string; created_at: string; updated_by: string | null; updated_at: string | null; revisions: number
  closed_by: string | null; closed_at: string | null
}
export type Revision = { id: number; entry_time: string | null; body: string; status: Status | null; edited_by: string; edited_at: string }

export const ENTRY_COLUMNS =
  'id, entry_date, shift, entry_time, body, status, created_by, created_at, updated_by, updated_at, revisions, closed_by, closed_at'

// Jam shift (WIB). Ubah di sini bila jadwal berganti; night dimulai malam dan berakhir pagi hari berikutnya.
export const SHIFTS: { key: ShiftKey; label: string; hours: string; from: number; to: number }[] = [
  { key: 'morning', label: 'Morning', hours: '07.00 – 15.00', from: 7, to: 15 },
  { key: 'evening', label: 'Evening', hours: '15.00 – 23.00', from: 15, to: 23 },
  { key: 'night', label: 'Night', hours: '23.00 – 07.00', from: 23, to: 7 },
]
export const shiftLabel = (k: ShiftKey): string => SHIFTS.find((s) => s.key === k)?.label ?? k

// Shift yang sedang berjalan menurut jam WIB, beserta tanggal MULAI shift (night lewat tengah malam = tanggal kemarin)
export function currentShift(now = new Date()): { date: string; shift: ShiftKey } {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(now)) % 24
  const today = todayWib()
  if (hour >= 7 && hour < 15) return { date: today, shift: 'morning' }
  if (hour >= 15 && hour < 23) return { date: today, shift: 'evening' }
  return { date: hour < 7 ? addDaysStr(today, -1) : today, shift: 'night' }
}

export const nowTimeWib = (): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())

export const hhmm = (t: string | null): string => (t ? t.slice(0, 5) : '')
export const EDIT_WINDOW_DAYS = 7

// Jumlah pekerjaan yang masih perlu dilanjutkan (lencana di tab Logbook), ikut berubah lewat realtime
export function useOpenCount(enabled: boolean): number {
  const [n, setN] = useState(0)
  const load = useCallback(async () => {
    const { count } = await supabase.from('logbook_entries').select('id', { count: 'exact', head: true }).eq('status', 'open')
    setN(count ?? 0)
  }, [])
  useEffect(() => { if (enabled) void load() }, [enabled, load])
  useRealtime('logbook_entries', () => void load(), { enabled })
  return enabled ? n : 0
}
