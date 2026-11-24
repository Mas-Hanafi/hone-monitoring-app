import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { DatePicker } from './DatePicker'
import { todayWib } from '../lib/date'
import type { Department, PicOption } from '../lib/types'
import { Backdrop } from './Backdrop'

type Props = {
  onClose: () => void
  onCreated: () => void
}

// Hanya SPV/Manager yang melihat form ini. Aturan sebenarnya (role, departemen PIC,
// deadline) ditegakkan oleh create_task di database; cek di sini hanya untuk pesan cepat.
export function CreateTaskSheet({ onClose, onCreated }: Props) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [pics, setPics] = useState<PicOption[]>([])
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const { profile } = useAuth()
  // SPV meminta atas nama departemennya sendiri; Manager memilih
  const [requesterId, setRequesterId] = useState(profile?.role === 'supervisor' ? String(profile.department_id) : '')
  const [picId, setPicId] = useState('')
  const [deadline, setDeadline] = useState('')
  const [urgent, setUrgent] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('departments').select('id, name').eq('is_active', true).order('sort_order'),
      // RLS membatasi: SPV hanya melihat departemennya, Manager semua
      supabase
        .from('profiles')
        .select('id, full_name, department_id, dept:departments(name)')
        .eq('is_active', true)
        .order('full_name'),
    ]).then(([d, p]) => {
      if (cancelled) return
      if (d.error || p.error) setError((d.error ?? p.error)?.message ?? 'Gagal memuat data')
      setDepartments((d.data ?? []) as Department[])
      // PIC hanya anggota tim ME; departemen lain meminta tugas
      setPics(((p.data ?? []) as unknown as PicOption[]).filter((x) => x.dept?.name === 'ME'))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!title.trim()) return setError('Judul wajib diisi.')
    if (!requesterId) return setError('Pilih departemen peminta.')
    if (!picId) return setError('Pilih PIC.')
    if (!deadline) return setError('Deadline wajib diisi.')
    if (deadline < todayWib()) return setError('Deadline tidak boleh di masa lalu.')

    setBusy(true)
    const { error: rpcError } = await supabase.rpc('create_task', {
      p_title: title.trim(),
      p_description: description.trim() || null,
      p_requester_department_id: Number(requesterId),
      p_pic_id: picId,
      p_deadline: deadline,
      p_is_urgent: urgent,
    })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    onCreated()
  }

  return (
    <Backdrop onClick={onClose}>
      <form className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}>
        <h2>Tugas baru</h2>
        {loading && <p className="hint">Memuat…</p>}

        <label className="field" htmlFor="ct-title">Judul tugas / project</label>
        <input id="ct-title" type="text" maxLength={200} value={title}
          onChange={(e) => setTitle(e.target.value)} />

        <label className="field" htmlFor="ct-desc">Keterangan (opsional)</label>
        <textarea id="ct-desc" rows={3} maxLength={2000} value={description}
          onChange={(e) => setDescription(e.target.value)} />

        <label className="field" htmlFor="ct-req">Departemen peminta</label>
        <select id="ct-req" value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>
          <option value="">Pilih…</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <label className="field" htmlFor="ct-pic">PIC</label>
        <select id="ct-pic" value={picId} onChange={(e) => setPicId(e.target.value)}>
          <option value="">Pilih…</option>
          {pics.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name} · {p.dept?.name ?? '-'}
            </option>
          ))}
        </select>

        <DatePicker id="ct-deadline" label="Deadline" min={todayWib()} value={deadline} onChange={setDeadline} />

        <label className="check">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
          Tandai urgent
        </label>

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="primary" disabled={busy || loading}>
            {busy ? 'Menyimpan…' : 'Buat tugas'}
          </button>
        </div>
      </form>
    </Backdrop>
  )
}
