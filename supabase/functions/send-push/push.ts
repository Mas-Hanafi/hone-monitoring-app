// Logika pengiriman push. Tanpa import; jaringan dan database disuntik, supaya mudah dites.
//
// Aturan:
//  - Notifikasi di dalam app selalu ada; push hanya tambahan. Pengguna tanpa langganan => langsung ditandai terkirim.
//  - Gagal sementara => tidak ditandai, dicoba lagi di putaran berikutnya, tapi hanya selama MAX_AGE_MS.
//    Push yang basi (terlambat berjam-jam) lebih mengganggu daripada berguna.
//  - 404/410 dari layanan push = langganan sudah mati => dihapus.
//  - Endpoint di luar daftar layanan push dikenal ditolak (pertahanan kedua; database sudah menyaring juga),
//    karena fungsi ini melakukan HTTP ke alamat itu.

export interface Notif { id: number; user_id: string; type: string; title: string; body: string; task_id: string | null; created_at: string }
export interface Sub { endpoint: string; user_id: string; p256dh: string; auth_secret: string }
export type SendResult = 'ok' | 'gone' | 'error'
export interface Payload { title: string; body: string; url: string; tag: string }

export interface Deps {
  readPending(limit: number): Promise<Notif[]>
  readSubs(userIds: string[]): Promise<Sub[]>
  send(sub: Sub, payload: Payload): Promise<SendResult>
  markPushed(ids: number[]): Promise<void>
  removeSubs(endpoints: string[]): Promise<void>
  now(): number
}

export interface DeliverResult { notifications: number; sent: number; removedSubs: number; retry: number }

export const MAX_AGE_MS = 60 * 60 * 1000

const ALLOWED_ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//

export const isAllowedEndpoint = (url: string): boolean => ALLOWED_ENDPOINT.test(url)

export function toPayload(n: Notif): Payload {
  return { title: n.title, body: n.body, url: '/', tag: `${n.type}:${n.task_id ?? n.id}` }
}

export async function deliver(deps: Deps, { batch = 200 } = {}): Promise<DeliverResult> {
  const out: DeliverResult = { notifications: 0, sent: 0, removedSubs: 0, retry: 0 }
  const pending = await deps.readPending(batch)
  out.notifications = pending.length
  if (!pending.length) return out

  const subs = await deps.readSubs([...new Set(pending.map((n) => n.user_id))])
  const gone = new Set<string>()
  const done: number[] = []

  for (const n of pending) {
    const mine = subs.filter((s) => s.user_id === n.user_id)
    for (const s of mine) if (!isAllowedEndpoint(s.endpoint)) gone.add(s.endpoint)
    const usable = mine.filter((s) => isAllowedEndpoint(s.endpoint))

    let anyOk = false
    let anyError = false
    for (const s of usable) {
      const r = await deps.send(s, toPayload(n))
      if (r === 'ok') { anyOk = true; out.sent++ }
      else if (r === 'gone') gone.add(s.endpoint)
      else anyError = true
    }

    const tooOld = deps.now() - Date.parse(n.created_at) > MAX_AGE_MS
    if (anyOk || !anyError || tooOld) done.push(n.id)
    else out.retry++
  }

  if (gone.size) { await deps.removeSubs([...gone]); out.removedSubs = gone.size }
  if (done.length) await deps.markPushed(done)
  return out
}
