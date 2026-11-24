import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { todayWib } from '../lib/date'
import { useAuth } from '../lib/auth'
import { DatePicker } from './DatePicker'
import { APPROVAL_LABEL, STATUS_LABEL, type Approval, type PicOption, type Task, type TaskStatus } from '../lib/types'
import { Backdrop } from './Backdrop'

type Mode = 'deadline' | 'pic'

interface HistoryRow {
  id: number
  event_type: 'created' | 'update' | 'deadline_change' | 'reassign' | 'approval'
  old_values: Record<string, string> | null
  new_values: Record<string, string> | null
  note: string | null
  created_at: string
  actor_id: string
  actor?: { full_name: string } | null
}

type Props = {
  task: Task
  onClose: () => void
  onSaved: () => void
}

function describe(h: HistoryRow): string {
  if (h.event_type === 'deadline_change') {
    return `Deadline ${h.old_values?.deadline ?? '?'} → ${h.new_values?.deadline ?? '?'}`
  }
  if (h.event_type === 'created') return 'Tugas dibuat'
  if (h.event_type === 'update') {
    const st = (h.new_values?.status ?? '') as TaskStatus
    return `Update: ${STATUS_LABEL[st] ?? st} · ${h.new_values?.progress ?? '?'}%`
  }
  if (h.event_type === 'reassign') {
    return `PIC ${h.old_values?.pic_name ?? '?'} → ${h.new_values?.pic_name ?? '?'}`
  }
  return `Penilaian: ${APPROVAL_LABEL[(h.new_values?.approval ?? 'pending') as Approval]}`
}

// Hanya SPV/Manager untuk tugas aktif. Alasan wajib; aturan sebenarnya ada di change_deadline dan reassign_pic.
export function ManageSheet({ task, onClose, onSaved }: Props) {
  const { profile } = useAuth()
  const isDeveloper = profile?.role === 'developer'
  const isStaff = profile?.role === 'staff' // staff ME boleh handover PIC, bukan ubah deadline
  const [mode, setMode] = useState<Mode>(isStaff ? 'pic' : 'deadline')
  const [deadline, setDeadline] = useState(task.deadline)
  const [picId, setPicId] = useState('')
  const [reason, setReason] = useState('')
  const [pics, setPics] = useState<PicOption[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      // RLS: SPV hanya melihat orang di departemennya, Manager semua
      supabase.from('profiles').select('id, full_name, department_id, dept:departments(name)')
        .eq('is_active', true).order('full_name'),
      supabase.from('task_events')
        .select('id, event_type, old_values, new_values, note, created_at, actor_id')
        .eq('task_id', task.id).order('created_at', { ascending: false }).limit(50),
    ]).then(async ([p, h]) => {
      const rows = (h.data ?? []) as unknown as HistoryRow[]
      // Nama lewat fungsi khusus: RLS profiles menyembunyikan orang di departemen lain dari SPV
      const { data: names } = rows.length
        ? await supabase.rpc('person_names', { p_ids: [...new Set(rows.map((r) => r.actor_id))] })
        : { data: [] as { id: string; full_name: string }[] }
      if (cancelled) return
      const nameOf = new Map<string, string>(((names ?? []) as { id: string; full_name: string }[]).map((n) => [n.id, n.full_name]))
      setPics(((p.data ?? []) as unknown as PicOption[]).filter((x) => x.id !== task.pic_id && x.dept?.name === 'ME'))
      setHistory(rows.map((r) => ({ ...r, actor: nameOf.has(r.actor_id) ? { full_name: nameOf.get(r.actor_id) as string } : null })))
    })
    return () => {
      cancelled = true
    }
  }, [task.id, task.pic_id])

  // Hanya Developer; fungsi di database menolak peran lain. Penghapusan tanpa jejak (permintaan pemilik).
  async function deleteLog(h: HistoryRow) {
    if (!window.confirm(`Hapus log ini permanen?
${describe(h)}
Tidak tercatat dan tidak bisa dikembalikan.`)) return
    const { error: delError } = await supabase.rpc('delete_task_events', { p_event_ids: [h.id] })
    if (delError) return setError(delError.message)
    setHistory((rows) => rows.filter((r) => r.id !== h.id))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!reason.trim()) return setError('Alasan wajib diisi.')
    if (mode === 'deadline') {
      if (!deadline) return setError('Pilih deadline baru.')
      if (deadline === task.deadline) return setError('Deadline belum diubah.')
      if (deadline < todayWib()) return setError('Deadline tidak boleh di masa lalu.')
    } else if (!picId) {
      return setError('Pilih PIC baru.')
    }

    setBusy(true)
    const { error: rpcError } =
      mode === 'deadline'
        ? await supabase.rpc('change_deadline', { p_task_id: task.id, p_new_deadline: deadline, p_reason: reason.trim() })
        : await supabase.rpc('reassign_pic', { p_task_id: task.id, p_new_pic_id: picId, p_reason: reason.trim() })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    onSaved()
  }

  return (
    <Backdrop onClick={onClose}>
      <form className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}>
        <h2>{task.title}</h2>
        <p className="meta">
          PIC {task.pic?.full_name ?? '-'} · deadline {task.deadline}
          {task.original_deadline !== task.deadline && ` (awal ${task.original_deadline})`}
        </p>

        <div className="chips">
          {!isStaff && (
            <button type="button" className={mode === 'deadline' ? 'chip on' : 'chip'} onClick={() => setMode('deadline')}>
              Ubah deadline
            </button>
          )}
          <button type="button" className={mode === 'pic' ? 'chip on' : 'chip'} onClick={() => setMode('pic')}>
            Ganti PIC
          </button>
        </div>

        {mode === 'deadline' ? (
          <>
            <DatePicker id="mg-deadline" label="Deadline baru" min={todayWib()} value={deadline} onChange={setDeadline} />
          </>
        ) : (
          <>
            <label className="field" htmlFor="mg-pic">PIC baru</label>
            <select id="mg-pic" value={picId} onChange={(e) => setPicId(e.target.value)}>
              <option value="">Pilih…</option>
              {pics.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name} · {p.dept?.name ?? '-'}</option>
              ))}
            </select>
          </>
        )}

        <label className="field" htmlFor="mg-reason">Alasan (wajib)</label>
        <textarea id="mg-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
        </div>

        <h3 className="section">Riwayat perubahan</h3>
        {history.length === 0 && <p className="hint">Belum ada perubahan.</p>}
        <ul className="history">
          {history.map((h) => (
            <li key={h.id}>
              <strong>{describe(h)}</strong>
              <span className="meta">
                {new Date(h.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} · {h.actor?.full_name ?? '-'}
              </span>
              {h.note && <span className="note">{h.note}</span>}
              {isDeveloper && h.event_type !== 'created' && (   // log "dibuat" dikunci: tugas akan hilang dari laporan
                <button type="button" className="ghost review" onClick={() => deleteLog(h)}>Hapus log</button>
              )}
            </li>
          ))}
        </ul>
      </form>
    </Backdrop>
  )
}
