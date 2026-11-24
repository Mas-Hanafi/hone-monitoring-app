import { useEffect, useRef } from 'react'
import { supabase } from './supabase'

type Opts = { filter?: string; enabled?: boolean }

// Berlangganan perubahan sebuah tabel lewat Supabase Realtime (RLS tetap berlaku: hanya baris yang boleh
// dilihat pengguna yang dikirim). onChange digabung supaya maksimal sekali per 400 ms. Dipanggil juga saat
// koneksi tersambung ulang dan saat layar kembali aktif, untuk mengejar kejadian yang terlewat di HP.
export function useRealtime(table: string, onChange: () => void, { filter, enabled = true }: Opts = {}) {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  })

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let subscribedBefore = false
    const fire = () => {
      clearTimeout(timer)
      timer = setTimeout(() => cb.current(), 400)
    }
    const channel = supabase
      .channel(`rt-${table}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, fire)
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (subscribedBefore) fire() // sambung ulang: muat ulang karena ada kejadian yang mungkin terlewat
        subscribedBefore = true
      })
    const onVisible = () => {
      if (document.visibilityState === 'visible') fire()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [table, filter, enabled])
}
