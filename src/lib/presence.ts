import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const PING_MS = 60_000
const MIN_GAP_MS = 30_000 // pemicu tab-terlihat/online bisa datang beruntun; jangan kirim lebih sering dari ini
const ONLINE_WITHIN_MS = 120_000
let lastPing = 0

// Semua akun: kirim "saya masih membuka app" tiap menit selama app terlihat. Hanya developer yang bisa membaca hasilnya.
export function usePresenceHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    lastPing = 0 // akun baru login di perangkat yang sama: ping pertama harus terkirim
    const ping = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      if (Date.now() - lastPing < MIN_GAP_MS) return
      lastPing = Date.now()
      supabase.rpc('touch_presence').then(() => {}, () => {}) // gagal diam-diam: bukan fitur kritis
    }
    ping()
    const id = window.setInterval(ping, PING_MS)
    document.addEventListener('visibilitychange', ping)
    window.addEventListener('online', ping)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', ping)
      window.removeEventListener('online', ping)
    }
  }, [enabled])
}

// Khusus developer (RLS mengembalikan kosong untuk yang lain). Menyegarkan tiap 30 detik.
export function usePresence(): { seen: Record<string, string>; signedIn: Record<string, string>; now: number } {
  const [seen, setSeen] = useState<Record<string, string>>({})
  const [signedIn, setSignedIn] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [p, s] = await Promise.all([
        supabase.from('user_presence').select('user_id, last_seen_at'),
        supabase.rpc('user_last_sign_in'),
      ])
      if (cancelled) return
      if (p.data) setSeen(Object.fromEntries(p.data.map((r) => [r.user_id as string, r.last_seen_at as string])))
      if (s.data) {
        const rows = s.data as { user_id: string; last_sign_in_at: string | null }[]
        setSignedIn(Object.fromEntries(rows.filter((r) => r.last_sign_in_at).map((r) => [r.user_id, r.last_sign_in_at as string])))
      }
      setNow(Date.now())
    }
    void load()
    const id = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])
  return { seen, signedIn, now }
}

const ago = (ms: number): string => {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'baru saja'
  if (min < 60) return `${min} menit lalu`
  const hour = Math.floor(min / 60)
  return hour < 24 ? `${hour} jam lalu` : `${Math.floor(hour / 24)} hari lalu`
}

export function presenceInfo(lastSeen: string | undefined, now: number, lastSignIn?: string): { online: boolean; text: string } {
  const seenMs = lastSeen ? Math.max(0, now - new Date(lastSeen).getTime()) : null
  const signMs = lastSignIn ? Math.max(0, now - new Date(lastSignIn).getTime()) : null
  // Login lebih baru daripada status terakhir: perangkatnya belum mengirim status (app belum diperbarui di perangkat itu)
  if (signMs !== null && (seenMs === null || signMs + 60_000 < seenMs)) {
    return { online: false, text: `login ${ago(signMs)} · belum mengirim status (app di perangkatnya belum diperbarui)` }
  }
  if (seenMs === null) return { online: false, text: 'belum pernah online' }
  if (seenMs < ONLINE_WITHIN_MS) return { online: true, text: 'online' }
  return { online: false, text: `terakhir online ${ago(seenMs)}` }
}
