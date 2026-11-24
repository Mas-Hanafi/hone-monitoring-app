import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Backdrop } from './Backdrop'

const MIN_LENGTH = 8

// Ganti sandi sendiri dari dalam app. Sandi lama diverifikasi dulu supaya HP yang
// tertinggal terbuka tidak bisa dipakai orang lain untuk mengunci pemilik akun.
export function ChangePasswordSheet({ onClose }: { onClose: () => void }) {
  const { session } = useAuth()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const email = session?.user.email
    if (!email) return setError('Sesi tidak valid. Keluar lalu masuk lagi.')
    if (password.length < MIN_LENGTH) return setError(`Kata sandi baru minimal ${MIN_LENGTH} karakter.`)
    if (password !== confirm) return setError('Kata sandi baru tidak sama.')
    if (password === current) return setError('Kata sandi baru harus berbeda dari yang lama.')
    setBusy(true)
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: current })
    if (verifyError) {
      setBusy(false)
      return setError('Kata sandi lama salah.')
    }
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (updateError) return setError(updateError.message)
    setDone(true)
  }

  return (
    <Backdrop onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>Ganti kata sandi</h2>
        {done ? (
          <>
            <p>Kata sandi sudah diganti. Pakai yang baru saat masuk berikutnya.</p>
            <button type="button" className="primary" onClick={onClose}>Tutup</button>
          </>
        ) : (
          <>
            <label className="field" htmlFor="cp0">Kata sandi lama</label>
            <input id="cp0" type="password" autoComplete="current-password" required value={current}
              onChange={(e) => setCurrent(e.target.value)} />
            <label className="field" htmlFor="cp1">Kata sandi baru</label>
            <input id="cp1" type="password" autoComplete="new-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <label className="field" htmlFor="cp2">Ulangi kata sandi baru</label>
            <input id="cp2" type="password" autoComplete="new-password" required value={confirm}
              onChange={(e) => setConfirm(e.target.value)} />
            {error && <p className="error">{error}</p>}
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
            <button type="button" className="ghost" onClick={onClose}>Batal</button>
          </>
        )}
      </form>
    </Backdrop>
  )
}
