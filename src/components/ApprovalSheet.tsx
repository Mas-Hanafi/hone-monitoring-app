import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { APPROVAL_LABEL, type Approval, type Task } from '../lib/types'
import { Backdrop } from './Backdrop'

type Decision = Exclude<Approval, 'pending'>
const DECISIONS: Decision[] = ['approved', 'hold', 'rejected']

type Props = {
  task: Task
  onClose: () => void
  onSaved: () => void
}

// Hanya SPV/Manager. Aturan sebenarnya (departemen, tugas sendiri, catatan wajib) ada di set_approval.
export function ApprovalSheet({ task, onClose, onSaved }: Props) {
  const [decision, setDecision] = useState<Decision | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const needsNote = decision === 'hold' || decision === 'rejected'

  async function handleSubmit() {
    setError('')
    if (!decision) return setError('Pilih Approve, Hold, atau Reject.')
    if (needsNote && !note.trim()) return setError('Catatan wajib diisi untuk Hold atau Reject.')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('set_approval', {
      p_task_id: task.id,
      p_decision: decision,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    onSaved()
  }

  return (
    <Backdrop onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{task.title}</h2>
        <p className="meta">
          Penilaian sekarang: {APPROVAL_LABEL[task.approval]} · {task.pic?.full_name ?? '-'} · {task.progress}%
        </p>

        <label className="field">Penilaian</label>
        <div className="chips">
          {DECISIONS.map((d) => (
            <button key={d} type="button" className={d === decision ? `chip on ${d}` : 'chip'}
              onClick={() => setDecision(d)}>
              {APPROVAL_LABEL[d]}
            </button>
          ))}
        </div>
        {decision === 'rejected' && (
          <p className="hint">Reject mengembalikan tugas selesai ke Dikerjakan.</p>
        )}

        <label className="field" htmlFor="ap-note">Catatan{needsNote ? ' (wajib)' : ' (opsional)'}</label>
        <textarea id="ap-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </div>
    </Backdrop>
  )
}
