import { useSyncExternalStore } from 'react'
import { registerSW } from 'virtual:pwa-register'

// Pembaruan app (PWA): versi baru diunduh di latar, lalu pengguna memilih kapan memuat ulang (tombol "Perbarui").
// Tidak dimuat ulang otomatis supaya isian yang sedang dikerjakan (foto, tanda tangan) tidak hilang.
let ready = false
const listeners = new Set<() => void>()
let doUpdate: ((reload?: boolean) => Promise<void>) | null = null

const notify = (v: boolean) => {
  ready = v
  listeners.forEach((l) => l())
}

export function initPwa() {
  doUpdate = registerSW({
    immediate: true,
    onNeedRefresh: () => notify(true),
    onRegisteredSW(_url, reg) {
      if (!reg) return
      // Cek versi baru berkala dan tiap app dibuka kembali dari latar (HP jarang memuat ulang halaman sendiri)
      const check = () => void reg.update().catch(() => undefined)
      setInterval(check, 10 * 60 * 1000)
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
    },
  })
}

// Jalur normal: service worker baru mengambil alih lalu halaman dimuat ulang. Bila dalam 4 detik halaman belum
// dimuat ulang (service worker macet), lepas service worker dan cache lalu muat ulang paksa.
// Draf isian (localStorage) dan antrean update offline (IndexedDB) tidak disentuh.
export function applyUpdate() {
  void doUpdate?.(true)
  window.setTimeout(() => {
    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
        for (const k of await caches.keys()) await caches.delete(k)
      } finally {
        window.location.reload()
      }
    })()
  }, 4000)
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => ready,
    () => false,
  )
}
