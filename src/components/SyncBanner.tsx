import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { discardUpdate, flushNow, startAutoSync, useOutbox } from '../lib/offline'

// Menjalankan kirim otomatis dan menampilkan status: offline, menunggu terkirim, ditolak server.
export function SyncBanner() {
  const { profile } = useAuth()
  const userId = profile?.id
  const { items, online } = useOutbox(userId)
  const [sending, setSending] = useState(false)

  useEffect(() => (userId ? startAutoSync(userId) : undefined), [userId])

  const pending = items.filter((i) => i.state === 'pending')
  const rejected = items.filter((i) => i.state === 'rejected')
  if (online && pending.length === 0 && rejected.length === 0) return null

  async function sendNow() {
    if (!userId) return
    setSending(true)
    await flushNow(userId)
    setSending(false)
  }

  return (
    <div className="banner" role="status">
      {!online && <p>Tidak ada koneksi. Update tetap tersimpan di perangkat dan terkirim otomatis saat sinyal kembali.</p>}
      {pending.length > 0 && (
        <p>
          {pending.length} update menunggu terkirim.{' '}
          {online && (
            <button type="button" className="link" onClick={sendNow} disabled={sending}>
              {sending ? 'Mengirim…' : 'Kirim sekarang'}
            </button>
          )}
        </p>
      )}
      {rejected.map((i) => (
        <p key={i.id} className="rejected">
          <strong>{i.taskTitle}</strong>: ditolak server — {i.error}{' '}
          <button type="button" className="link" onClick={() => discardUpdate(i.id)}>Buang</button>
        </p>
      ))}
    </div>
  )
}
