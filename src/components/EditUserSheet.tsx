import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { functionError } from '../lib/functions'
import { ROLE_LABEL, type Department, type Role, type UserRow } from '../lib/types'
import { Backdrop } from './Backdrop'

const ROLES = Object.keys(ROLE_LABEL) as Role[]

type Props = {
  user: UserRow
  departments: Department[]
  onClose: () => void
  onSaved: () => void
}

// Hanya Developer. Menonaktifkan akun = akun langsung kehilangan semua akses data (dijaga RLS).
export function EditUserSheet({ user, departments, onClose, onSaved }: Props) {
  const { profile } = useAuth()
  const isSelf = profile?.id === user.id

  const [role, setRole] = useState<Role>(user.role)
  const [deptId, setDeptId] = useState(String(user.department_id))
  const [active, setActive] = useState(user.is_active)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirming, setConfirming] = useState(false)

  // Atur ulang sandi tanpa email: Developer menentukan sandi sementara, lalu menyampaikannya langsung.
  // Langkah 1: validasi, lalu minta konfirmasi di layar (bukan window.confirm: bisa diblokir/tak terlihat).
  function askReset() {
    setError('')
    setInfo('')
    if (newPw.length < 8) return setError('Kata sandi minimal 8 karakter.')
    setConfirming(true)
  }

  // Langkah 2: kirim ke server.
  async function resetPassword() {
    setConfirming(false)
    setBusy(true)
    const { error: fnError } = await supabase.functions.invoke('set-password', {
      body: { user_id: user.id, password: newPw },
    })
    setBusy(false)
    if (fnError) return setError(await functionError(fnError))
    setNewPw('')
    setInfo('Sandi sudah diganti. Sampaikan sandi baru ke orangnya; ia bisa menggantinya lewat tombol Sandi.')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('admin_update_profile', {
      p_user_id: user.id,
      p_role: role,
      p_department_id: Number(deptId),
      p_is_active: active,
    })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    onSaved()
  }

  return (
    <Backdrop onClick={onClose}>
      <form className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}>
        <h2>{user.full_name}</h2>
        {isSelf && <p className="hint">Akun sendiri: role Developer dan status aktif tidak bisa diubah.</p>}

        <label className="field" htmlFor="eu-role">Role</label>
        <select id="eu-role" value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>

        <label className="field" htmlFor="eu-dept">Departemen</label>
        <select id="eu-dept" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        <label className="check">
          <input type="checkbox" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
          Akun aktif
        </label>

        <label className="field" htmlFor="eu-pw">Atur ulang kata sandi (opsional)</label>
        <input id="eu-pw" type="text" autoComplete="off" placeholder="Sandi sementara, minimal 8 karakter" value={newPw}
          onChange={(e) => { setNewPw(e.target.value); setConfirming(false) }}
          onKeyDown={(e) => {
            // Enter di sini harus mengatur ulang sandi, bukan men-submit form profil (Simpan)
            if (e.key === 'Enter') {
              e.preventDefault()
              askReset()
            }
          }} />
        {confirming ? (
          <div className="panel">
            <p>Atur ulang kata sandi <strong>{user.full_name}</strong>? Sandi lama langsung tidak berlaku.</p>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setConfirming(false)} disabled={busy}>Batal</button>
              <button type="button" className="primary" onClick={resetPassword} disabled={busy}>Ya, atur ulang</button>
            </div>
          </div>
        ) : (
          <button type="button" className="ghost" onClick={askReset} disabled={busy || newPw.length === 0}>
            {busy ? 'Memproses…' : 'Atur ulang sandi'}
          </button>
        )}

        {error && <p className="error">{error}</p>}
        {info && <p className="hint">{info}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
        </div>
      </form>
    </Backdrop>
  )
}
