// Penghubung antrean offline ke browser dan Supabase: IndexedDB, jaringan, hook React.
// Logika keputusan (apa yang dikirim, kapan berhenti, kapan ditolak) ada di queue.ts dan diuji di sana.
import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { idb } from './idb'
import {
  classifyRpcError, classifyStorageError, flush,
  type FlushResult, type QueuedUpdate, type Remote, type Store,
} from './queue'

const SEND_WAIT_MS = 15_000 // menunggu hasil kirim sebelum sheet ditutup sebagai "menunggu terkirim"
const AUTO_SYNC_MS = 30_000

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

const store: Store = {
  async list() {
    return (await idb.getAll<QueuedUpdate>('outbox')).sort((a, b) => a.createdAt - b.createdAt)
  },
  async put(item) {
    await idb.put('outbox', item)
    notify()
  },
  async remove(id) {
    await idb.del('outbox', id)
    notify()
  },
}

const remote: Remote = {
  async upload(path, blob) {
    try {
      const { error } = await supabase.storage.from('task-photos').upload(path, blob, { contentType: 'image/jpeg' })
      if (!error) return { kind: 'ok' }
      return classifyStorageError({ message: error.message, statusCode: (error as { statusCode?: string }).statusCode })
    } catch (e: unknown) {
      return { kind: 'transient', message: e instanceof Error ? e.message : 'Gagal mengunggah' }
    }
  },
  async report(item) {
    try {
      const { error } = await supabase.rpc('report_progress', {
        p_task_id: item.taskId,
        p_status: item.payload.status,
        p_progress: item.payload.progress,
        p_note: item.payload.note,
        p_is_urgent: item.payload.urgent,
        p_photo_paths: item.photos.map((p) => p.path),
        p_client_id: item.id,
      })
      return error ? classifyRpcError({ code: error.code, message: error.message }) : { kind: 'ok' }
    } catch (e: unknown) {
      return { kind: 'transient', message: e instanceof Error ? e.message : 'Gagal mengirim' }
    }
  },
}

// Satu pengiriman pada satu waktu (antar tab dilindungi client_id di server dan 409 di storage)
let running: Promise<FlushResult> | null = null

export function flushNow(userId: string): Promise<FlushResult> {
  running ??= flush(store, remote, userId).finally(() => {
    running = null
    notify()
  })
  return running
}

export type SendOutcome = 'sent' | 'queued' | { rejected: string }

// Simpan dulu ke perangkat (aman walau sinyal putus / app ditutup), baru coba kirim.
export async function enqueueAndSend(item: QueuedUpdate): Promise<SendOutcome> {
  await store.put(item)
  if (!navigator.onLine) return 'queued'
  if (running) await running.catch(() => undefined) // beri kesempatan pengiriman yang sedang jalan selesai
  const result = await Promise.race([
    flushNow(item.userId),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SEND_WAIT_MS)),
  ])
  if (result === 'timeout') return 'queued'
  if (result.sent.includes(item.id)) return 'sent'
  const rejected = result.rejected.find((r) => r.id === item.id)
  if (rejected) {
    await store.remove(item.id) // ditolak saat pengguna masih di layar: tampilkan pesan, jangan menumpuk di antrean
    return { rejected: rejected.message }
  }
  return 'queued'
}

export async function discardUpdate(id: string): Promise<void> {
  await store.remove(id)
}

// Kirim otomatis: saat app dibuka, kembali online, kembali ke layar, dan berkala selama ada yang menunggu.
export function startAutoSync(userId: string): () => void {
  const tryFlush = () => {
    if (navigator.onLine) void flushNow(userId)
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') tryFlush()
  }
  tryFlush()
  window.addEventListener('online', tryFlush)
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(tryFlush, AUTO_SYNC_MS)
  return () => {
    window.removeEventListener('online', tryFlush)
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(timer)
  }
}

export function useOutbox(userId: string | undefined) {
  const [items, setItems] = useState<QueuedUpdate[]>([])
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const all = await store.list().catch(() => [])
      if (alive) setItems(userId ? all.filter((i) => i.userId === userId) : [])
    }
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    refresh()
    listeners.add(refresh)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      alive = false
      listeners.delete(refresh)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [userId])

  return { items, online }
}

// ---- salinan terakhir data untuk dibuka tanpa sinyal ----
export async function cachePut(key: string, value: unknown): Promise<void> {
  try {
    await idb.put('cache', { key, value, savedAt: Date.now() })
  } catch {
    /* cache bersifat tambahan; gagal menyimpan tidak boleh mengganggu app */
  }
}

export async function cacheGet<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
  try {
    return (await idb.get<{ value: T; savedAt: number }>('cache', key)) ?? null
  } catch {
    return null
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await idb.del('cache', key)
  } catch {
    /* abaikan */
  }
}

// Saat keluar akun: salinan data kinerja dihapus dari perangkat. Antrean (milik pengguna itu) tetap ada.
export async function clearCache(): Promise<void> {
  try {
    await idb.clear('cache')
  } catch {
    /* abaikan */
  }
}
