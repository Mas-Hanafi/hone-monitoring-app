import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { capitalize, loadRunAnswers, ansKey, type Answers, type Item, type Run, type Subject, type Template } from '../lib/routine'

type Props = {
  template: Template
  items: Item[]
  subjects: Subject[]
  run: Run
  inspectorName: string
  canReopen: boolean
  onClose: () => void
  onChanged: () => void
}

type Evidence = { signature: string | null; photos: string[] }

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short' })
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { timeZone: 'UTC', dateStyle: 'long' })

// Laporan satu isian checklist: hasil per butir, temuan NG, foto, dan tanda tangan Tim ME.
// Tombol "Cetak" membuka dialog cetak browser (bisa disimpan sebagai PDF); CSS cetak menyembunyikan menu app.
export function RoutineReport({ template, items, subjects: allSubjects, run, inspectorName, canReopen, onClose, onChanged }: Props) {
  const [answers, setAnswers] = useState<Answers | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [error, setError] = useState('')
  const [confirmReopen, setConfirmReopen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const a = await loadRunAnswers(run.id)
        const { data, error: fError } = await supabase.from('routine_files').select('kind, storage_path').eq('run_id', run.id).order('id')
        if (fError) throw new Error(fError.message)
        const rows = (data ?? []) as { kind: 'photo' | 'signature'; storage_path: string }[]
        const { data: signed, error: sError } = await supabase.storage.from('routine-files')
          .createSignedUrls(rows.map((r) => r.storage_path), 3600)
        if (sError) throw new Error(sError.message)
        const urlOf = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
        if (off) return
        setAnswers(a)
        setEvidence({
          signature: urlOf.get(rows.find((r) => r.kind === 'signature')?.storage_path ?? '') ?? null,
          photos: rows.filter((r) => r.kind === 'photo').map((r) => urlOf.get(r.storage_path)).filter((u): u is string => !!u),
        })
      } catch (e: unknown) {
        if (!off) setError(e instanceof Error ? e.message : 'Gagal memuat laporan')
      }
    })()
    return () => { off = true }
  }, [run.id])

  async function reopen() {
    setBusy(true); setError('')
    const { error: rpcError } = await supabase.rpc('reopen_routine_run', { p_run: run.id })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    onChanged(); onClose()
  }

  const valueOf = (it: Item, sid: number | null): { text: string; cls: string } => {
    const a = answers?.[ansKey(it.id, sid)]
    if (!a?.status) return { text: '-', cls: '' }
    if (it.kind === 'text') return { text: a.note ?? '', cls: '' }
    if (it.kind === 'number') return a.status === 'na' ? { text: 'N/A', cls: 'na' } : { text: `${a.num ?? ''}${it.unit ? ` ${it.unit}` : ''}`, cls: '' }
    return { text: a.status === 'ok' ? 'OK' : a.status === 'ng' ? 'NG' : 'N/A', cls: a.status }
  }

  const table = (list: Item[], sid: number | null) => {
    const sections = [...new Set(list.map((i) => i.section))]
    return sections.map((sec) => (
      <table key={`${sid}-${sec}`} className="rp-table">
        <thead><tr><th colSpan={3}>{sec}</th></tr></thead>
        <tbody>
          {list.filter((i) => i.section === sec).map((it) => {
            const v = valueOf(it, sid)
            const note = it.kind === 'text' ? '' : answers?.[ansKey(it.id, sid)]?.note
            return (
              <tr key={it.id}>
                <td>{it.label.replace(' | ', ' · ')}</td>
                <td className={`rp-v ${v.cls}`}>{v.text}</td>
                <td className="rp-note">{note ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    ))
  }

  // hanya objek yang diperiksa pada isian ini (Room dikirim per kamar)
  const subjects = answers ? allSubjects.filter((s) => items.some((it) => answers[ansKey(it.id, s.id)])) : allSubjects
  const ngs: { where: string; label: string; note: string }[] = []
  if (answers) {
    for (const it of items) {
      for (const s of it.scope === 'run' ? [null] : subjects) {
        const a = answers[ansKey(it.id, s?.id ?? null)]
        if (a?.status === 'ng') ngs.push({ where: s?.label ?? 'Umum', label: it.label, note: a.note ?? '' })
      }
    }
  }
  const runItems = items.filter((i) => i.scope === 'run')
  const subItems = items.filter((i) => i.scope === 'subject')

  return (
    <div className="rt-report">
      <div className="row no-print">
        <button type="button" className="ghost" onClick={onClose}>← Kembali</button>
        <button type="button" className="primary" onClick={() => window.print()} disabled={!answers}>Cetak / simpan PDF</button>
      </div>

      <header className="rp-head">
        <h2 className="title">Laporan checklist {template.name} ({template.frequency === 'weekly' ? 'mingguan' : 'harian'})</h2>
        <p className="meta">H One · Tim ME</p>
        <p className="meta">Periode: {template.frequency === 'weekly' ? `minggu ${fmtDate(run.period)}` : fmtDate(run.period)}</p>
        {template.mode === 'per_subject' && answers && <p className="meta">{capitalize(template.subject_noun)} diperiksa: {subjects.map((s) => s.label).join(', ') || '-'}</p>}
        <p className="meta">Diisi oleh {inspectorName} · dikirim {fmtDateTime(run.submitted_at)}</p>
        <p className={run.ng_count ? 'rp-result ng' : 'rp-result ok'}>{run.ng_count ? `${run.ng_count} temuan NG` : 'Semua butir OK'}</p>
      </header>

      {error && <p className="error">{error}</p>}
      {!answers && !error && <p className="hint">Memuat…</p>}

      {answers && (
        <>
          {ngs.length > 0 && (
            <section className="rp-sec">
              <h3 className="section">Temuan NG</h3>
              <table className="rp-table">
                <tbody>
                  {ngs.map((n, i) => (
                    <tr key={i}><td>{n.where}</td><td>{n.label}</td><td className="rp-note">{n.note}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {runItems.length > 0 && <section className="rp-sec"><h3 className="section">Umum</h3>{table(runItems, null)}</section>}
          {subItems.length > 0 && subjects.map((s) => (
            <section key={s.id} className="rp-sec rp-subject"><h3 className="section">{s.label}</h3>{table(subItems, s.id)}</section>
          ))}

          <section className="rp-sec rp-evidence">
            <h3 className="section">Bukti foto</h3>
            <div className="rp-photos">
              {evidence?.photos.map((u, i) => <img key={u} src={u} alt={`Foto bukti ${i + 1}`} />)}
              {evidence && evidence.photos.length === 0 && <p className="hint">Foto tidak tersedia.</p>}
            </div>
            <h3 className="section">Tanda tangan</h3>
            <div className="rp-sign">
              {evidence?.signature ? <img src={evidence.signature} alt={`Tanda tangan ${inspectorName}`} /> : <p className="hint">Tanda tangan tidak tersedia.</p>}
              <div><strong>{inspectorName}</strong></div>
              <div className="meta">Tim ME · {fmtDateTime(run.submitted_at)}</div>
            </div>
          </section>
        </>
      )}

      {canReopen && (
        <div className="rt-submit no-print">
          {confirmReopen ? (
            <>
              <p className="hint">Isian ini akan dihapus supaya bisa diisi ulang. Tindakan dicatat di log admin.</p>
              <div className="actions left">
                <button type="button" className="primary" disabled={busy} onClick={reopen}>Ya, buka ulang</button>
                <button type="button" className="ghost" onClick={() => setConfirmReopen(false)}>Batal</button>
              </div>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setConfirmReopen(true)}>Buka ulang isian</button>
          )}
        </div>
      )}
    </div>
  )
}
