import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Task } from '../lib/types'
import { Backdrop } from './Backdrop'

interface Shot {
  id: string
  url: string
  created_at: string
  by: string
}

type Props = { task: Task; onClose: () => void }

// Hanya SPV/Manager/Developer (aturan sebenarnya ada di RLS tabel attachments dan policy Storage).
// Foto dihapus otomatis setelah 3 hari, jadi daftar kosong itu wajar untuk tugas lama.
export function PhotoSheet({ task, onClose }: Props) {
  const [shots, setShots] = useState<Shot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [big, setBig] = useState<Shot | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error: qError } = await supabase
        .from('attachments')
        .select('id, storage_path, created_at, uploaded_by')
        .eq('task_id', task.id)
        .order('created_at', { ascending: false })
        .limit(50)
      if (cancelled) return
      if (qError) {
        setError(qError.message)
        setLoading(false)
        return
      }
      const rows = (data ?? []) as unknown as { id: string; storage_path: string; created_at: string; uploaded_by: string }[]
      if (rows.length === 0) {
        setLoading(false)
        return
      }
      // Nama lewat fungsi khusus: RLS profiles menyembunyikan orang di departemen lain dari SPV
      const { data: names } = await supabase.rpc('person_names', { p_ids: [...new Set(rows.map((r) => r.uploaded_by))] })
      const nameOf = new Map<string, string>(((names ?? []) as { id: string; full_name: string }[]).map((n) => [n.id, n.full_name]))
      const { data: signed, error: sError } = await supabase.storage
        .from('task-photos')
        .createSignedUrls(rows.map((r) => r.storage_path), 600)
      if (cancelled) return
      if (sError) {
        setError(sError.message)
        setLoading(false)
        return
      }
      const out: Shot[] = []
      rows.forEach((r, i) => {
        const url = signed?.[i]?.signedUrl
        // Berkas sudah terhapus (lewat 3 hari) => tidak ada url, lewati
        if (url) out.push({ id: r.id, url, created_at: r.created_at, by: nameOf.get(r.uploaded_by) ?? '-' })
      })
      setShots(out)
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [task.id])

  const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })

  return (
    <Backdrop onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Foto · {task.title}</h2>
        <p className="meta">Foto disimpan 3 hari, lalu dihapus otomatis.</p>

        {loading && <p className="hint">Memuat…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && shots.length === 0 && <p className="hint">Tidak ada foto (belum diunggah atau sudah lewat 3 hari).</p>}

        <div className="photo-grid">
          {shots.map((s) => (
            <button key={s.id} type="button" className="photo" onClick={() => setBig(s)}>
              <img src={s.url} alt={`Foto oleh ${s.by}`} loading="lazy" />
              <span className="meta">{s.by} · {when(s.created_at)}</span>
            </button>
          ))}
        </div>

        {big && (
          <div className="lightbox" onClick={() => setBig(null)}>
            <img src={big.url} alt={`Foto oleh ${big.by}`} />
            <span>{big.by} · {when(big.created_at)}</span>
          </div>
        )}

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>Tutup</button>
        </div>
      </div>
    </Backdrop>
  )
}
