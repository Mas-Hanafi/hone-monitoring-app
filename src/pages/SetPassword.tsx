import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const MIN_LENGTH = 8

// Ditampilkan setelah pengguna membuka tautan undangan atau reset sandi.
export function SetPassword() {
  const { passwordSet } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_LENGTH) return setError(`Kata sandi minimal ${MIN_LENGTH} karakter.`)
    if (password !== confirm) return setError('Kata sandi tidak sama.')
    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (updateError) return setError(updateError.message)
    window.history.replaceState(null, '', window.location.pathname)
    passwordSet()
  }

  return (
    <main className="login">
      <form onSubmit={handleSubmit}>
        <h1>Atur kata sandi</h1>
        <label className="field" htmlFor="np">Kata sandi baru</label>
        <input id="np" type="password" autoComplete="new-password" required value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <label className="field" htmlFor="np2">Ulangi kata sandi</label>
        <input id="np2" type="password" autoComplete="new-password" required value={confirm}
          onChange={(e) => setConfirm(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Menyimpan…' : 'Simpan dan masuk'}
        </button>
      </form>
    </main>
  )
}
