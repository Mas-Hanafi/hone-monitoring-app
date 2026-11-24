import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { compressPhoto } from '../lib/photo'
import { SignaturePad } from './SignaturePad'
import {
  ansKey, buildPayload, clearDraft, expectedKeys, isAnswered, loadDraft, saveDraft,
  type Ans, type Answers, type Item, type Subject, type Template,
} from '../lib/routine'

type Props = {
  template: Template
  items: Item[]
  subjects: Subject[]
  doneSubjects: Set<number>   // objek yang sudah diperiksa periode ini (mode per_subject)
  userId: string
  period: string
  onClose: () => void
  onChanged: () => void
}

type Row = { item: Item } | { group: string; items: Item[] }
type Shot = { blob: Blob; url: string }
const SEP = ' | '
const MAX_PHOTOS = 6

// Butir berawalan sama ("Tegangan antar-fasa | R-S") digabung jadi satu baris berisi beberapa kolom angka
function toRows(items: Item[]): { section: string; rows: Row[] }[] {
  const sections: { section: string; rows: Row[] }[] = []
  for (const item of items) {
    let sec = sections[sections.length - 1]
    if (!sec || sec.section !== item.section) { sec = { section: item.section, rows: [] }; sections.push(sec) }
    const g = item.label.includes(SEP) ? item.label.split(SEP)[0] : null
    const last = sec.rows[sec.rows.length - 1]
    if (g && last && 'group' in last && last.group === g) last.items.push(item)
    else sec.rows.push(g ? { group: g, items: [item] } : { item })
  }
  return sections
}

const rand = () => Math.random().toString(36).slice(2, 10)

export function RoutineForm({ template, items, subjects: allSubjects, doneSubjects, userId, period, onClose, onChanged }: Props) {
  const { profile } = useAuth()
  const perSubject = template.mode === 'per_subject'
  const noun = template.subject_noun // kamar / panel
  const periodWord = template.frequency === 'weekly' ? 'minggu ini' : 'hari ini'
  const [draft0] = useState(() => loadDraft(userId, template.key, period))
  const [answers, setAnswers] = useState<Answers>(draft0.answers)
  // mode per_subject: hanya objek (kamar/panel) yang SUDAH ADA isiannya (dan belum diperiksa pada periode ini) yang wajib lengkap.
  // Membuka atau mengetuk objek tanpa mengisi apa pun tidak mewajibkannya.
  const [subjectId, setSubjectId] = useState<number | null>(perSubject ? null : (allSubjects[0]?.id ?? null))
  const touched = useMemo(
    () => allSubjects.filter((sj) => !doneSubjects.has(sj.id) && Object.keys(answers).some((k) => k.endsWith(`:${sj.id}`))),
    [allSubjects, doneSubjects, answers],
  )
  const picked = useMemo(() => touched.map((sj) => sj.id), [touched])
  const subjects = perSubject ? touched : allSubjects
  const [shots, setShots] = useState<Shot[]>([])
  const [signature, setSignature] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showMissing, setShowMissing] = useState(false) // setelah mengetuk Kirim saat belum lengkap: tandai butir yang kurang
  const uploaded = useRef(new Map<Blob, string>()) // blob -> path; unggahan yang sudah berhasil tidak diulang saat kirim ulang

  useEffect(() => {
    saveDraft(userId, template.key, period, { answers, picked })
  }, [answers, picked, userId, template.key, period])
  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.url)), [shots])

  const expected = useMemo(() => expectedKeys(items, subjects), [items, subjects])
  const done = expected.filter((e) => isAnswered(e.item, answers[e.key])).length
  const ngCount = expected.filter((e) => answers[e.key]?.status === 'ng').length
  const answersComplete = done === expected.length
  const evidenceComplete = !!signature && shots.length >= 1
  const complete = answersComplete && evidenceComplete && (!perSubject || subjects.length > 0)
  // Butir yang belum lengkap, dengan alasannya, supaya pengisi tahu persis apa yang kurang (bukan hanya jumlahnya)
  const missingItems = expected
    .filter((e) => !isAnswered(e.item, answers[e.key]))
    .map((e) => {
      const a = answers[e.key]
      const sj = allSubjects.find((x) => x.id === e.subjectId)
      return {
        key: e.key, subjectId: e.subjectId,
        text: `${sj && (allSubjects.length > 1 || perSubject) ? `${sj.label} › ` : ''}${e.item.label.replace(SEP, ' ')}`,
        why: a?.status === 'ng' ? 'NG belum dicatat' : e.item.kind === 'number' ? 'angka belum diisi' : 'belum dipilih',
      }
    })
  const scrollToId = (id: string) =>
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })))
  const jump = (m: { key: string; subjectId: number | null }) => {
    setShowMissing(true)
    if (m.subjectId !== null) setSubjectId(m.subjectId)
    scrollToId(`rt-${m.key}`)
  }

  const set = (item: Item, sid: number | null, patch: Ans | null) =>
    setAnswers((cur) => {
      const k = ansKey(item.id, sid)
      const next = { ...cur }
      if (patch === null) delete next[k]
      else next[k] = { ...cur[k], ...patch }
      return next
    })

  const scopeItems = (scope: 'run' | 'subject') => items.filter((i) => i.scope === scope)
  const subjectDone = (sid: number) => {
    const mine = expected.filter((e) => e.subjectId === sid)
    return mine.length > 0 && mine.every((e) => isAnswered(e.item, answers[e.key]))
  }
  const subjectNg = (sid: number) => expected.some((e) => e.subjectId === sid && answers[e.key]?.status === 'ng')

  // "Semua OK": hanya mengisi yang masih kosong, tidak menimpa temuan NG
  const fillOk = (scope: 'run' | 'subject', sid: number | null) => {
    setAnswers((cur) => {
      const next = { ...cur }
      for (const it of scopeItems(scope)) {
        if (it.kind !== 'check' && it.kind !== 'check_na') continue
        const k = ansKey(it.id, sid)
        if (!next[k]?.status) next[k] = { status: 'ok' }
      }
      return next
    })
  }

  // Mode per_subject: ketuk objek untuk memeriksanya; "Lewati" menghapus isiannya (diperiksa nanti atau oleh rekan)
  const openSubject = (id: number) => {
    if (doneSubjects.has(id)) return
    setSubjectId(id)
  }
  const skipSubject = (id: number) => {
    setAnswers((cur) => {
      const next = { ...cur }
      for (const k of Object.keys(next)) if (k.endsWith(`:${id}`)) delete next[k]
      return next
    })
    setSubjectId(null)
  }

  async function addPhotos(files: FileList | null) {
    if (!files) return
    setError('')
    try {
      const stamp = `${profile?.full_name ?? ''} · ${template.name} · ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
      const added: Shot[] = []
      for (const f of Array.from(files).slice(0, MAX_PHOTOS - shots.length)) {
        const blob = await compressPhoto(f, stamp)
        added.push({ blob, url: URL.createObjectURL(blob) })
      }
      setShots((cur) => [...cur, ...added])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal memproses foto')
    }
  }
  const removePhoto = (i: number) => setShots((cur) => cur.filter((_, k) => k !== i))

  async function upload(blob: Blob, kind: 'photo' | 'signature'): Promise<string> {
    const known = uploaded.current.get(blob)
    if (known) return known
    const type = blob.type || (kind === 'signature' ? 'image/png' : 'image/jpeg')
    const path = `${template.key}/${period}/${userId}/${kind}-${rand()}.${type === 'image/png' ? 'png' : 'jpg'}`
    // ArrayBuffer + tipe eksplisit: lebih andal di Safari iPhone daripada mengirim Blob lewat FormData ("Load failed")
    const body = await blob.arrayBuffer()
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error: upError } = await supabase.storage.from('routine-files').upload(path, body, { contentType: type, upsert: false })
        // percobaan ke-2 setelah yang pertama sebenarnya sampai di server: berkas sudah ada, anggap berhasil
        if (!upError || /already exists|duplicate/i.test(upError.message)) { uploaded.current.set(blob, path); return path }
        lastError = upError.message
      } catch (e: unknown) {
        lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }
    }
    throw new Error(`Unggah ${kind === 'signature' ? 'tanda tangan' : 'foto'} gagal (${lastError}, ${Math.round(body.byteLength / 1024)} KB)`)
  }

  async function submit() {
    if (!signature) return
    setBusy(true); setError('')
    try {
      const files: { kind: string; path: string }[] = [{ kind: 'signature', path: await upload(signature, 'signature') }]
      for (const s of shots) files.push({ kind: 'photo', path: await upload(s.blob, 'photo') })
      const { error: rpcError } = await supabase.rpc('submit_routine_run', {
        p_template: template.key, p_answers: buildPayload(items, subjects, answers), p_files: files,
      })
      if (rpcError) throw new Error(rpcError.message)
      clearDraft(userId, template.key, period)
      onChanged(); onClose()
    } catch (e: unknown) {
      setError(`${e instanceof Error ? e.message : 'Gagal mengirim'}. Isian tetap tersimpan sebagai draf di HP ini; foto dan tanda tangan perlu dilampirkan lagi bila halaman ditutup.`)
    }
    setBusy(false)
  }

  const renderRow = (row: Row, sid: number | null) => {
    if ('group' in row) {
      const gMissing = showMissing && row.items.some((it) => !isAnswered(it, answers[ansKey(it.id, sid)]))
      return (
        <div key={row.group} className={gMissing ? 'rt-item rt-missing' : 'rt-item'}>
          <div className="rt-label">{row.group}{row.items[0].unit ? ` (${row.items[0].unit})` : ''}</div>
          <div className="rt-nums">
            {row.items.map((it) => (
              <NumberField key={it.id} id={`rt-${ansKey(it.id, sid)}`} item={it} ans={answers[ansKey(it.id, sid)]} sub={it.label.split(SEP)[1]}
                onChange={(p) => set(it, sid, p)} />
            ))}
          </div>
        </div>
      )
    }
    const it = row.item
    const a = answers[ansKey(it.id, sid)]
    const missing = showMissing && it.kind !== 'text' && !isAnswered(it, a)
    return (
      <div key={it.id} id={it.kind === 'number' ? undefined : `rt-${ansKey(it.id, sid)}`} className={missing ? 'rt-item rt-missing' : 'rt-item'}>
        <div className="rt-label">{it.label}{it.kind === 'number' && it.unit ? ` (${it.unit})` : ''}</div>
        {it.kind === 'text' ? (
          <textarea rows={2} maxLength={500} value={a?.note ?? ''} placeholder="Catatan (opsional)"
            onChange={(e) => set(it, sid, e.target.value ? { status: 'ok', note: e.target.value } : null)} />
        ) : it.kind === 'number' ? (
          <NumberField id={`rt-${ansKey(it.id, sid)}`} item={it} ans={a} onChange={(p) => set(it, sid, p)} />
        ) : (
          <>
            <div className="rt-opts" role="group" aria-label={it.label}>
              <button type="button" aria-pressed={a?.status === 'ok'} className="rt-ok" onClick={() => set(it, sid, { status: 'ok' })}>OK</button>
              <button type="button" aria-pressed={a?.status === 'ng'} className="rt-ng" onClick={() => set(it, sid, { status: 'ng' })}>NG</button>
              {it.kind === 'check_na' && (
                <button type="button" aria-pressed={a?.status === 'na'} className="rt-na" onClick={() => set(it, sid, { status: 'na' })}>N/A</button>
              )}
            </div>
            {a?.status === 'ng' && (
              <input type="text" maxLength={300} value={a.note ?? ''} placeholder="Catatan temuan (wajib)"
                aria-label={`Catatan temuan ${it.label}`} className="rt-note" onChange={(e) => set(it, sid, { note: e.target.value })} />
            )}
          </>
        )}
      </div>
    )
  }

  const block = (title: string, list: Item[], sid: number | null) =>
    toRows(list).map((s) => (
      <section key={`${title}-${s.section}`} className="rt-sec">
        <h3 className="section">{s.section}</h3>
        {s.rows.map((r) => renderRow(r, sid))}
      </section>
    ))

  const subjectLabel = allSubjects.find((s) => s.id === subjectId)?.label
  const runItems = scopeItems('run')
  const subItems = scopeItems('subject')
  const total = expected.length + 2 // + tanda tangan dan foto
  const doneAll = done + (signature ? 1 : 0) + (shots.length ? 1 : 0)

  return (
    <div className="rt-form">
      <div className="row">
        <button type="button" className="ghost" onClick={onClose}>← Kembali</button>
        <span className="meta">{doneAll}/{total} terisi{ngCount > 0 ? ` · ${ngCount} NG` : ''}</span>
      </div>
      <h2 className="title">{template.name} · {template.frequency === 'weekly' ? 'mingguan' : 'harian'}</h2>
      <p className="meta">Periode {period}. Draf tersimpan otomatis di HP ini.</p>
      <div className="rt-bar"><span style={{ width: `${(100 * doneAll) / total}%` }} /></div>

      {runItems.length > 0 && (
        <>
          <button type="button" className="chip" onClick={() => fillOk('run', null)}>Semua OK (yang masih kosong)</button>
          {block('run', runItems, null)}
        </>
      )}

      {subItems.length > 0 && allSubjects.length > 0 && (
        <>
          {perSubject && (
            <p className="meta">
              Pilih {noun} yang bisa diperiksa sekarang. Yang belum bisa diperiksa boleh dilewati; kirim belakangan, atau biarkan rekan tim yang mengerjakannya.
              Sudah diperiksa {periodWord}: {doneSubjects.size}/{allSubjects.length} {noun}.
            </p>
          )}
          <div className={perSubject ? 'rt-subs rt-subs-wrap' : 'rt-subs'} role="tablist" aria-label="Objek yang diperiksa">
            {allSubjects.map((s) => {
              const done = doneSubjects.has(s.id)
              const isPicked = !perSubject || picked.includes(s.id)
              const partial = isPicked && !subjectDone(s.id)
              return (
                <button key={s.id} type="button" role="tab" aria-selected={s.id === subjectId} disabled={done}
                  className={['rt-sub', s.id === subjectId ? 'on' : '', isPicked && subjectDone(s.id) ? 'done' : '', isPicked && subjectNg(s.id) ? 'ng' : '', done ? 'was' : '', perSubject && !isPicked && !done ? 'idle' : '', partial ? 'part' : ''].join(' ')}
                  onClick={() => (perSubject ? openSubject(s.id) : setSubjectId(s.id))}>
                  {s.label}{done ? ' ✓✓' : isPicked && subjectNg(s.id) ? ' !' : isPicked && subjectDone(s.id) ? ' ✓' : partial ? ' …' : ''}
                </button>
              )
            })}
          </div>
          {perSubject && <p className="hint">✓✓ = sudah diperiksa {periodWord}. ✓ = lengkap. … = baru terisi sebagian (lengkapi atau ketuk "Lewati {noun} ini").</p>}
          {subjectId !== null && allSubjects.some((s) => s.id === subjectId) && (
            <>
              <h3 className="rt-subtitle">{subjectLabel}</h3>
              <div className="actions left">
                <button type="button" className="chip" onClick={() => fillOk('subject', subjectId)}>Semua OK di {subjectLabel} (yang masih kosong)</button>
                {perSubject && <button type="button" className="ghost" onClick={() => skipSubject(subjectId)}>Lewati {noun} ini</button>}
              </div>
              {block('subject', subItems, subjectId)}
            </>
          )}
          {perSubject && subjects.length === 0 && <p className="hint">Belum ada {noun} dipilih. Ketuk salah satu di atas untuk mulai.</p>}
        </>
      )}

      <section className="rt-sec rt-evidence" id="rt-evidence">
        <h3 className="section">Bukti dan tanda tangan</h3>
        <div className="rt-label">Foto ({shots.length}/{MAX_PHOTOS}, minimal 1)</div>
        <div className="rt-shots">
          {shots.map((s, i) => (
            <figure key={s.url} className="rt-shot">
              <img src={s.url} alt={`Foto ${i + 1}`} />
              <button type="button" className="ghost" onClick={() => removePhoto(i)} aria-label={`Hapus foto ${i + 1}`}>Hapus</button>
            </figure>
          ))}
        </div>
        {shots.length < MAX_PHOTOS && (
          <label className="chip rt-pick">
            + Tambah foto
            <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = '' }} />
          </label>
        )}
        <div className="rt-label">Tanda tangan {profile?.full_name ?? ''} (Tim ME)</div>
        <SignaturePad onChange={setSignature} />
      </section>

      {error && <p className="error">{error}</p>}
      {!complete && (
          <div className="rt-missing-box" id="rt-missing-box" role="status">
            {perSubject && subjects.length === 0 ? (
              <p className="hint">Isi minimal satu {noun} (ketuk salah satu di atas, lalu isi butirnya).</p>
            ) : (
              <>
                <p className="hint">Belum lengkap. Ketuk untuk melompat ke butir yang kurang:</p>
                <ul className="rt-miss">
                  {missingItems.slice(0, 8).map((m) => (
                    <li key={m.key}><button type="button" className="link" onClick={() => jump(m)}>{m.text}</button> <span className="meta">{m.why}</span></li>
                  ))}
                  {missingItems.length > 8 && <li className="meta">dan {missingItems.length - 8} butir lainnya</li>}
                  {!shots.length && <li><button type="button" className="link" onClick={() => { setShowMissing(true); scrollToId('rt-evidence') }}>Foto</button> <span className="meta">minimal 1</span></li>}
                  {!signature && <li><button type="button" className="link" onClick={() => { setShowMissing(true); scrollToId('rt-evidence') }}>Tanda tangan</button> <span className="meta">belum digambar</span></li>}
                </ul>
              </>
            )}
          </div>
        )}
      <div className="rt-submit">
        {!complete && (
          <p className="hint">
            Belum lengkap{missingItems.length ? `: ${missingItems.length} butir` : ''}{!shots.length ? `${missingItems.length ? ',' : ':'} foto` : ''}{!signature ? `${missingItems.length || !shots.length ? ',' : ':'} tanda tangan` : ''}. Ketuk Kirim untuk melihat daftarnya.
          </p>
        )}
        <button type="button" className="primary" disabled={busy}
          onClick={() => { if (complete) { void submit(); return } setShowMissing(true); scrollToId('rt-missing-box') }}>
          {busy ? 'Mengirim…' : 'Kirim checklist'}
        </button>
      </div>
    </div>
  )
}

function NumberField({ id, item, ans, sub, onChange }: { id?: string; item: Item; ans: Ans | undefined; sub?: string; onChange: (p: Ans | null) => void }) {
  const na = ans?.status === 'na'
  return (
    <div className="rt-num" id={id}>
      {sub && <span className="rt-sublabel">{sub}</span>}
      <input type="text" inputMode="decimal" disabled={na} value={na ? '' : (ans?.num ?? '')} placeholder={na ? 'N/A' : '0'}
        aria-label={item.label}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.,-]/g, '')
          onChange(v ? { status: 'ok', num: v } : null)
        }} />
      <button type="button" aria-pressed={na} className="rt-na rt-na-s" aria-label={`${item.label} tidak tersedia`}
        onClick={() => onChange(na ? null : { status: 'na', num: undefined })}>N/A</button>
    </div>
  )
}
