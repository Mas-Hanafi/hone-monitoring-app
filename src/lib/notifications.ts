import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useRealtime } from './realtime'

export interface NotificationRow {
  id: number
  type: string
  title: string
  body: string
  created_at: string
  read_at: string | null
}

const POLL_MS = 60_000

// Daftar 50 notifikasi terbaru milik sendiri (RLS). Diperbarui tiap menit, saat layar kembali aktif,
// dan saat sinyal kembali. Gagal memuat (offline) diabaikan: daftar lama tetap tampil.
export function useNotifications(userId: string | undefined) {
  const [items, setItems] = useState<NotificationRow[]>([])

  const refresh = useCallback(async () => {
    if (!userId) return
    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, body, created_at, read_at')
      .order('created_at', { ascending: false })
      .limit(50)
    if (!error) setItems(data as NotificationRow[])
  }, [userId])

  // Notifikasi baru muncul seketika di lonceng; polling tiap menit di bawah hanya cadangan
  useRealtime('notifications', refresh, { filter: userId ? `user_id=eq.${userId}` : undefined, enabled: !!userId })

  useEffect(() => {
    refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const timer = setInterval(refresh, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', refresh)
    }
  }, [refresh])

  const markRead = useCallback(
    async (ids?: number[]) => {
      await supabase.rpc('mark_notifications_read', { p_ids: ids ?? null })
      await refresh()
    },
    [refresh],
  )

  return { items, unread: items.filter((i) => !i.read_at).length, markRead }
}
