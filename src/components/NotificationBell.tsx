import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useNotifications } from '../lib/notifications'
import { disablePush, enablePush, pushState, syncPushOwner, type PushState } from '../lib/push'
import { Backdrop } from './Backdrop'

const PUSH_HINT: Record<PushState, string> = {
  'no-key': 'Notifikasi HP belum dipasang oleh Developer.',
  unsupported: 'Browser ini tidak mendukung notifikasi HP.',
  'needs-install': 'Di iPhone: buka menu Bagikan → "Tambah ke Layar Utama", lalu buka app dari ikon itu.',
  denied: 'Izin notifikasi diblokir. Ubah lewat pengaturan browser/aplikasi, lalu muat ulang.',
  off: 'Notifikasi HP belum aktif di perangkat ini.',
  on: 'Notifikasi HP aktif di perangkat ini.',
}

const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' })

export function NotificationBell() {
  const { profile } = useAuth()
  const { items, unread, markRead } = useNotifications(profile?.id)
  const [open, setOpen] = useState(false)
  const [push, setPush] = useState<PushState>('off')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const userId = profile?.id
  useEffect(() => {
    if (!userId) return
    // Perangkat yang sudah punya langganan dipindahkan ke akun yang sedang login
    syncPushOwner().catch(() => undefined)
    pushState().then(setPush).catch(() => setPush('unsupported'))
  }, [userId])

  async function togglePush() {
    setBusy(true)
    setError('')
    try {
      if (push === 'on') await disablePush()
      else {
        const err = await enablePush()
        if (err) setError(err)
      }
      setPush(await pushState())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal mengubah pengaturan notifikasi.')
    }
    setBusy(false)
  }

  if (!profile) return null

  return (
    <>
      <button type="button" className="bell" aria-label={`Notifikasi, ${unread} belum dibaca`} onClick={() => setOpen(true)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <Backdrop onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h2>Notifikasi</h2>
              {unread > 0 && (
                <button type="button" className="link" onClick={() => markRead()}>Tandai semua dibaca</button>
              )}
            </div>

            <div className="panel pushbox">
              <span className="meta">{PUSH_HINT[push]}</span>
              {(push === 'off' || push === 'on') && (
                <button type="button" className={push === 'on' ? 'ghost' : 'primary'} onClick={togglePush} disabled={busy}>
                  {busy ? 'Memproses…' : push === 'on' ? 'Matikan' : 'Aktifkan notifikasi HP'}
                </button>
              )}
              {error && <span className="error">{error}</span>}
            </div>

            {items.length === 0 && <p className="hint">Belum ada notifikasi.</p>}
            <ul className="notifs">
              {items.map((n) => (
                <li key={n.id} className={n.read_at ? '' : 'unread'}>
                  <button type="button" onClick={() => !n.read_at && markRead([n.id])}>
                    <strong>{n.title}</strong>
                    {n.body && <span>{n.body}</span>}
                    <span className="meta">{when(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="actions">
              <button type="button" className="ghost" onClick={() => setOpen(false)}>Tutup</button>
            </div>
          </div>
        </Backdrop>
      )}
    </>
  )
}
