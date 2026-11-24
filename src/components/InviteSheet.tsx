import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { functionError } from '../lib/functions'
import { ROLE_LABEL, type Department, type Role } from '../lib/types'
import { Backdrop } from './Backdrop'

const ROLES = Object.keys(ROLE_LABEL) as Role[]

type Props = {
  departments: Department[]
  onClose: () => void
  onInvited: () => void
}

// Hanya Developer. Akun langsung dibuat dengan sandi awal (tanpa email: email login bukan mailbox sungguhan).
// Edge Function invite-user mengecek role lagi di server.
export function InviteSheet({ departments, onClose, onInvited }: Props) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [deptId, setDeptId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!deptId) return setError('Pilih departemen.')
    if (password.length < 8) return setError('Sandi awal minimal 8 karakter.')
    setBusy(true)
    const { error: fnError } = await supabase.functions.invoke('invite-user', {
      body: {
        email, full_name: name, role, department_id: Number(deptId), password,
      },
    })
    setBusy(false)
    if (fnError) return setError(await functionError(fnError))
    setCreated(email.trim().toLowerCase())
  }

  if (created) {
    return (
      <Backdrop onClick={onInvited}>
        <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <h2>Akun dibuat</h2>
          <p>
            Akun <strong>{created}</strong> sudah aktif. Sampaikan email dan sandi awalnya langsung ke orangnya;
            ia bisa menggantinya lewat tombol Sandi setelah masuk.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={onInvited}>Selesai</button>
          </div>
        </div>
      </Backdrop>
    )
  }

  return (
    <Backdrop onClick={onClose}>
      <form className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}>
        <h2>Buat akun</h2>

        <label className="field" htmlFor="iv-email">Email (untuk masuk)</label>
        <input id="iv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />

        <label className="field" htmlFor="iv-name">Nama lengkap</label>
        <input id="iv-name" type="text" required maxLength={100} value={name}
          onChange={(e) => setName(e.target.value)} />

        <label className="field" htmlFor="iv-pw">Sandi awal</label>
        <input id="iv-pw" type="text" autoComplete="off" required minLength={8} maxLength={72} value={password}
          onChange={(e) => setPassword(e.target.value)} />

        <label className="field" htmlFor="iv-role">Role</label>
        <select id="iv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>

        <label className="field" htmlFor="iv-dept">Departemen</label>
        <select id="iv-dept" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
          <option value="">Pilih…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Membuat…' : 'Buat akun'}
          </button>
        </div>
      </form>
    </Backdrop>
  )
}
