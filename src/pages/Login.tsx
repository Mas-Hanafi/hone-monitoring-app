import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

// Tautan undangan/reset yang kedaluwarsa kembali dengan error di hash URL
const LINK_ERROR = new URLSearchParams(window.location.hash.slice(1)).get('error_description')

// Akun dibuat Developer lewat undangan; tidak ada pendaftaran mandiri.
export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(LINK_ERROR ? 'Tautan sudah kedaluwarsa. Hubungi developer untuk mengatur ulang kata sandi.' : '')
  const [info, setInfo] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setInfo('')
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) setError('Email atau kata sandi salah.')
    setBusy(false)
  }

  return (
    <main className="login">
      <form onSubmit={handleSubmit}>
        <h1 className="logo">
          <img src="/logo.webp" width="296" height="198" alt="H One Monitoring Apps" />
        </h1>
        <label className="field" htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <label className="field" htmlFor="password">Kata sandi</label>
        <input id="password" type="password" autoComplete="current-password" required value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error">{error}</p>}
        {info && <p className="hint">{info}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Masuk…' : 'Masuk'}
        </button>
        <p className="hint">Lupa kata sandi? Hubungi developer untuk mengatur ulang.</p>
      </form>
    </main>
  )
}
