import { useState } from 'react'
import { supabase } from '../lib/supabase'

type Kind = 'check' | 'check_na' | 'number' | 'text'
type Row = { id: number; section: string; label: string; kind: Kind; unit: string; scope: '' | 'run' | 'subject' }

const KIND_LABEL: Record<Kind, string> = { check: 'OK / NG', check_na: 'OK / NG / N/A', number: 'Angka', text: 'Catatan (opsional)' }
let nextId = 1
const blank = (section = ''): Row => ({ id: nextId++, section, label: '', kind: 'check', unit: '', scope: '' })

const lines = (text: string): string[] =>
  text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

type Props = { onClose: () => void; onCreated: () => void }

// Tambah rutinitas (checklist) baru. Boleh: tim ME, editor rutinitas, Developer (database yang menegakkan).
export function RoutineBuilder({ onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [freq, setFreq] = useState<'daily' | 'weekly'>('daily')
  const [subjText, setSubjText] = useState('')
  const [noun, setNoun] = useState('')
  const [mode, setMode] = useState<'whole' | 'per_subject'>('per_subject')
  const [rows, setRows] = useState<Row[]>(() => [blank()])
  const [bulk, setBulk] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const subjects = lines(subjText)
  const hasSubjects = subjects.length > 0
  const effScope = (r: Row): 'run' | 'subject' => (!hasSubjects ? 'run' : r.scope || 'subject')
  const filled = rows.filter((r) => r.label.trim())

  const patch = (id: number, p: Partial<Row>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const remove = (id: number) => setRows((cur) => (cur.length > 1 ? cur.filter((r) => r.id !== id) : [blank()]))
  const addBulk = () => {
    const section = [...rows].reverse().find((r) => r.section.trim())?.section ?? ''
    const added = bulk.split('\n').map((x) => x.trim()).filter(Boolean).map((label) => ({ ...blank(section), label }))
    if (!added.length) return
    setRows((cur) => [...cur.filter((r) => r.label.trim() || r.section.trim()), ...added])
    setBulk('')
  }

  async function save() {
    setError('')
    if (name.trim().length < 2) return setError('Isi nama rutinitas (minimal 2 huruf).')
    if (!filled.length) return setError('Tambahkan minimal satu butir pemeriksaan.')
    if (!filled.some((r) => r.kind !== 'text')) return setError('Minimal satu butir harus wajib diisi (bukan hanya catatan).')
    if (hasSubjects && !filled.some((r) => effScope(r) === 'subject')) return setError('Dengan daftar objek, minimal satu butir harus diisi tiap objek.')
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('create_routine', {
      p_name: name.trim(),
      p_frequency: freq,
      p_mode: hasSubjects ? mode : 'whole',
      p_noun: noun.trim() || 'objek',
      p_subjects: subjects,
      p_items: filled.map((r) => ({
        section: r.section.trim() || 'Umum', label: r.label.trim(), kind: r.kind,
        unit: r.kind === 'number' ? r.unit.trim() : '', scope: effScope(r),
      })),
    })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    onCreated()
  }

  return (
    <div className="rt-form">
      <div className="row">
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>← Kembali</button>
      </div>
      <h2 className="title">Tambah rutinitas</h2>
      <p className="meta">Untuk rutinitas yang belum terdaftar. Setelah disimpan, rutinitas muncul di tab Rutin dan semua akun dikabari. Isiannya tetap wajib tanda tangan dan foto.</p>

      <label className="field" htmlFor="rb-name">Nama rutinitas</label>
      <input id="rb-name" type="text" maxLength={60} value={name} placeholder="Contoh: Pompa air, Kolam renang" onChange={(e) => setName(e.target.value)} />

      <div className="rt-label">Seberapa sering</div>
      <div className="chips">
        <button type="button" className={freq === 'daily' ? 'chip on' : 'chip'} onClick={() => setFreq('daily')}>Harian</button>
        <button type="button" className={freq === 'weekly' ? 'chip on' : 'chip'} onClick={() => setFreq('weekly')}>Mingguan</button>
      </div>

      <label className="field" htmlFor="rb-subj">Objek yang diperiksa (opsional)</label>
      <textarea id="rb-subj" rows={3} value={subjText} placeholder={'Satu per baris atau dipisah koma.\nContoh: Pompa 1, Pompa 2, Pompa 3'} onChange={(e) => setSubjText(e.target.value)} />
      <p className="hint">Kosongkan bila rutinitas ini satu checklist untuk seluruh area. {hasSubjects ? `${subjects.length} objek.` : ''}</p>

      {hasSubjects && (
        <>
          <label className="field" htmlFor="rb-noun">Sebutan objek</label>
          <input id="rb-noun" type="text" maxLength={20} value={noun} placeholder="Contoh: pompa, kamar, panel" onChange={(e) => setNoun(e.target.value)} />
          <div className="rt-label">Cara mengirim</div>
          <div className="chips">
            <button type="button" className={mode === 'per_subject' ? 'chip on' : 'chip'} onClick={() => setMode('per_subject')}>Per objek, boleh bergantian</button>
            <button type="button" className={mode === 'whole' ? 'chip on' : 'chip'} onClick={() => setMode('whole')}>Satu isian untuk semua objek</button>
          </div>
          <p className="hint">{mode === 'per_subject'
            ? 'Tiap objek dikirim sendiri-sendiri, oleh siapa pun di tim ME. Cocok bila objeknya banyak.'
            : 'Semua objek harus diisi sekaligus oleh satu orang, satu kali per periode.'}</p>
        </>
      )}

      <h3 className="section">Butir pemeriksaan</h3>
      {rows.map((r, i) => (
        <div key={r.id} className="rt-item">
          <input type="text" maxLength={160} value={r.label} aria-label={`Butir ${i + 1}`} placeholder="Butir pemeriksaan, misal: Lampu menyala" onChange={(e) => patch(r.id, { label: e.target.value })} />
          <div className="rb-line">
            <select aria-label="Jenis isian" value={r.kind} onChange={(e) => patch(r.id, { kind: e.target.value as Kind })}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            {r.kind === 'number' && <input type="text" className="rb-unit" maxLength={12} value={r.unit} placeholder="Satuan" aria-label="Satuan" onChange={(e) => patch(r.id, { unit: e.target.value })} />}
            {hasSubjects && (
              <select aria-label="Diisi untuk" value={effScope(r)} onChange={(e) => patch(r.id, { scope: e.target.value as 'run' | 'subject' })}>
                <option value="subject">Tiap objek</option>
                <option value="run">Sekali saja</option>
              </select>
            )}
          </div>
          <input type="text" maxLength={60} value={r.section} aria-label="Bagian" placeholder="Bagian (opsional), misal: Kondisi umum" onChange={(e) => patch(r.id, { section: e.target.value })} />
          <button type="button" className="ghost" onClick={() => remove(r.id)}>Hapus butir</button>
        </div>
      ))}
      <button type="button" className="chip add" onClick={() => setRows((cur) => [...cur, blank([...cur].reverse().find((x) => x.section.trim())?.section ?? '')])}>+ Tambah butir</button>

      <label className="field" htmlFor="rb-bulk">Atau tempel banyak butir sekaligus (satu per baris, jenis OK / NG)</label>
      <textarea id="rb-bulk" rows={4} value={bulk} placeholder={'Lampu menyala\nPintu terkunci\nAPAR tersedia'} onChange={(e) => setBulk(e.target.value)} />
      <button type="button" className="ghost" disabled={!bulk.trim()} onClick={addBulk}>Tambahkan butir</button>

      {error && <p className="error">{error}</p>}
      <div className="rt-submit">
        <p className="hint">{filled.length} butir{hasSubjects ? ` · ${subjects.length} objek` : ''} · {freq === 'daily' ? 'harian' : 'mingguan'}</p>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Menyimpan…' : 'Simpan rutinitas'}</button>
      </div>
    </div>
  )
}
