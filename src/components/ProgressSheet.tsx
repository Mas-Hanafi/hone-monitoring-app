import { useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import { compressPhoto } from '../lib/photo'
import { enqueueAndSend } from '../lib/offline'
import type { QueuedUpdate } from '../lib/queue'
import { STATUS_LABEL, type Role, type Task, type TaskStatus } from '../lib/types'
import { Backdrop } from './Backdrop'

const STEPS = [0, 25, 50, 75, 100]

type Props = {
  task: Task
  role: Role
  userName: string
  onClose: () => void
  onSaved: () => void
}

// Aturan di sini hanya untuk pesan cepat di UI; yang menegakkan tetap report_progress di database.
export function ProgressSheet({ task, role, userName, onClose, onSaved }: Props) {
  const { profile } = useAuth()
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [progress, setProgress] = useState(task.progress)
  const [note, setNote] = useState('')
  const [urgent, setUrgent] = useState(task.is_urgent)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Kunci idempotensi + foto yang sudah dikompres (path tetap), supaya "Coba lagi" tidak menggandakan apa pun
  const clientId = useRef(crypto.randomUUID())
  const prepared = useRef(new Map<File, { path: string; blob: Blob }>())

  const isClosing = status === 'done' || status === 'handover'
  const shownProgress = isClosing ? 100 : progress
  const statuses = (Object.keys(STATUS_LABEL) as TaskStatus[]).filter(
    (s) => s !== 'cancelled' || role !== 'staff',
  )

  async function handleSubmit() {
    setError('')
    const statusChanged = status !== task.status
    if (role === 'staff' && statusChanged && files.length === 0) {
      return setError('Foto wajib dilampirkan saat status berubah.')
    }
    if ((status === 'on_hold' || shownProgress < task.progress) && !note.trim()) {
      return setError('Catatan wajib diisi saat tugas di-hold atau progress turun.')
    }

    if (!profile) return setError('Sesi tidak ditemukan. Masuk lagi.')
    setBusy(true)
    try {
      const label = `${userName} · ${new Date().toLocaleString('id-ID')} · ${task.title}`
      for (const file of files) {
        if (prepared.current.has(file)) continue
        prepared.current.set(file, {
          path: `${task.id}/${crypto.randomUUID()}.jpg`, // path wajib '<task_id>/<nama-file>'
          blob: await compressPhoto(file, label),
        })
      }
      const item: QueuedUpdate = {
        id: clientId.current,
        userId: profile.id,
        taskId: task.id,
        taskTitle: task.title,
        payload: { status, progress: shownProgress, note: note.trim() || null, urgent },
        photos: files.map((f) => ({ ...(prepared.current.get(f) as { path: string; blob: Blob }), uploaded: false })),
        createdAt: Date.now(),
        state: 'pending',
        error: null,
      }
      // Disimpan di perangkat dulu, lalu dikirim. Tanpa sinyal: tetap tersimpan dan terkirim otomatis nanti.
      const outcome = await enqueueAndSend(item)
      if (typeof outcome === 'object') throw new Error(outcome.rejected)
      onSaved()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Backdrop onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{task.title}</h2>

        <label className="field">Status</label>
        <div className="chips">
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              className={s === status ? 'chip on' : 'chip'}
              onClick={() => setStatus(s)}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        <label className="field">Progress: {shownProgress}%</label>
        <div className="bar big">
          <span style={{ width: `${shownProgress}%` }} />
        </div>
        <div className="chips">
          {STEPS.map((n) => (
            <button
              key={n}
              type="button"
              className={n === shownProgress ? 'chip on' : 'chip'}
              disabled={isClosing}
              onClick={() => setProgress(n)}
            >
              {n}
            </button>
          ))}
        </div>

        <label className="field">Catatan / kendala</label>
        <textarea
          value={note}
          maxLength={1000}
          rows={3}
          placeholder="Wajib jika hold atau progress turun"
          onChange={(e) => setNote(e.target.value)}
        />

        <label className="field">Foto</label>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        {files.length > 0 && <p className="hint">{files.length} foto dipilih</p>}

        <label className="check">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
          Tandai urgent
        </label>

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Batal
          </button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </div>
    </Backdrop>
  )
}
