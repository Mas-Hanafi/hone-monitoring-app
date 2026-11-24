// Mesin antrean update offline. Murni (tanpa import runtime): penyimpanan dan jaringan disuntik,
// supaya bisa dites tanpa browser.
//
// Aturan inti:
//  - Satu update = satu item dengan id tetap (client_id). Server memakai id itu sebagai kunci
//    idempotensi, jadi kirim ulang tidak menggandakan event.
//  - Hanya item milik pengguna yang sedang login yang dikirim (perangkat bersama: update milik A
//    tidak boleh terkirim atas nama B).
//  - Gagal sementara (jaringan, sesi, server) => berhenti, item tetap antre, coba lagi nanti.
//  - Ditolak aturan server (tugas sudah ditutup, tidak berwenang, dst.) => ditandai 'rejected',
//    TIDAK dicoba lagi, menunggu dibuang pengguna. Tanpa ini satu item buruk memblokir selamanya.

export interface QueuedPhoto { path: string; blob: Blob; uploaded: boolean }

export interface QueuedUpdate {
  id: string
  userId: string
  taskId: string
  taskTitle: string
  payload: { status: string; progress: number; note: string | null; urgent: boolean }
  photos: QueuedPhoto[]
  createdAt: number
  state: 'pending' | 'rejected'
  error: string | null
}

export interface Store {
  list(): Promise<QueuedUpdate[]>
  put(item: QueuedUpdate): Promise<void>
  remove(id: string): Promise<void>
}

export type RemoteResult =
  | { kind: 'ok' }
  | { kind: 'transient'; message: string }
  | { kind: 'rejected'; message: string }

export interface Remote {
  upload(path: string, blob: Blob): Promise<RemoteResult>
  report(item: QueuedUpdate): Promise<RemoteResult>
}

export interface FlushResult {
  sent: string[]
  rejected: { id: string; message: string }[]
  stopped: boolean // berhenti karena gagal sementara
}

const NETWORK_MESSAGE = /failed to fetch|network|load failed|timeout|offline/i

// Error dari rpc()/select() PostgREST. Kode kosong = fetch gagal (tidak sampai server).
export function classifyRpcError(e: { code?: string | null; message: string }): RemoteResult {
  const code = e.code ?? ''
  if (!code || NETWORK_MESSAGE.test(e.message)) return { kind: 'transient', message: e.message }
  if (code === 'PGRST301' || /jwt/i.test(e.message)) return { kind: 'transient', message: 'Sesi habis, masuk lagi.' }
  if (/^(PGRST0|08|53|57)/.test(code)) return { kind: 'transient', message: e.message }
  return { kind: 'rejected', message: e.message }
}

// Error dari storage.upload(). Foto yang sudah ada (kiriman ulang) dianggap sukses.
export function classifyStorageError(e: { message: string; statusCode?: string | number | null }): RemoteResult {
  const status = String(e.statusCode ?? '')
  if (status === '409' || /already exists|duplicate/i.test(e.message)) return { kind: 'ok' }
  if (!status || NETWORK_MESSAGE.test(e.message)) return { kind: 'transient', message: e.message }
  if (/jwt|token|expired/i.test(e.message)) return { kind: 'transient', message: 'Sesi habis, masuk lagi.' }
  if (status.startsWith('4')) return { kind: 'rejected', message: `Foto ditolak: ${e.message}` }
  return { kind: 'transient', message: e.message }
}

export async function flush(store: Store, remote: Remote, userId: string): Promise<FlushResult> {
  const out: FlushResult = { sent: [], rejected: [], stopped: false }
  const items = (await store.list())
    .filter((i) => i.userId === userId && i.state === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)

  for (const item of items) {
    const reject = async (message: string) => {
      await store.put({ ...item, state: 'rejected', error: message })
      out.rejected.push({ id: item.id, message })
    }

    let failed = false
    for (const photo of item.photos) {
      if (photo.uploaded) continue
      const r = await remote.upload(photo.path, photo.blob)
      if (r.kind === 'transient') { out.stopped = true; return out }
      if (r.kind === 'rejected') { await reject(r.message); failed = true; break }
      photo.uploaded = true
      await store.put(item) // simpan kemajuan: kiriman ulang tidak mengunggah foto yang sama lagi
    }
    if (failed) continue

    const r = await remote.report(item)
    if (r.kind === 'transient') { out.stopped = true; return out }
    if (r.kind === 'rejected') { await reject(r.message); continue }
    await store.remove(item.id)
    out.sent.push(item.id)
  }
  return out
}
