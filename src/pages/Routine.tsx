import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { RoutineForm } from '../components/RoutineForm'
import { RoutineReport } from '../components/RoutineReport'
import { RoutineBuilder } from '../components/RoutineBuilder'
import { Skeleton } from '../components/Skeleton'
import { addDaysStr } from '../lib/date'
import {
  currentPeriod, expectedKeys, isAnswered, loadCatalog, loadDoneSubjects, loadDraft,
  type Catalog, type Run, type Template,
} from '../lib/routine'

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short' })
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })

// Rutin tim ME: genset (harian, satu isian per hari), panel (harian, per panel), room (mingguan, per kamar).
export function Routine() {
  const { profile } = useAuth()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState('')
  const [open, setOpen] = useState<{ template: Template; run?: Run; period: string } | null>(null)
  const [canFill, setCanFill] = useState(false)
  const [canEdit, setCanEdit] = useState(false) // boleh menambah rutinitas: tim ME, editor rutinitas, Developer
  const [building, setBuilding] = useState(false)
  const [done, setDone] = useState<Map<number, Set<number>>>(new Map()) // template id -> objek (kamar/panel) yang sudah diperiksa periode ini
  const [roomsOf, setRoomsOf] = useState<Map<string, string[]>>(new Map()) // run id -> objek pada isian itu

  const load = useCallback(async () => {
    setError('')
    try {
      const cat = await loadCatalog()
      setCatalog(cat)
      const { data, error: qError } = await supabase
        .from('routine_runs').select('id, template_id, period, inspector_id, ng_count, submitted_at')
        .order('submitted_at', { ascending: false }).limit(40)
      if (qError) throw new Error(qError.message)
      const list = (data ?? []) as Run[]
      setRuns(list)
      const doneMap = new Map<number, Set<number>>()
      for (const t of cat.templates.filter((x) => x.mode === 'per_subject')) doneMap.set(t.id, await loadDoneSubjects(t.id, currentPeriod(t)))
      setDone(doneMap)
      if (list.length) {
        const { data: rs } = await supabase.from('routine_run_subjects').select('run_id, subject:routine_subjects(label)').in('run_id', list.map((r) => r.id)).limit(500)
        const m = new Map<string, string[]>()
        for (const x of (rs ?? []) as unknown as { run_id: string; subject: { label: string } | null }[]) {
          if (x.subject) m.set(x.run_id, [...(m.get(x.run_id) ?? []), x.subject.label])
        }
        setRoomsOf(m)
      }
      const ids = [...new Set(list.map((r) => r.inspector_id))]
      if (ids.length) {
        const { data: n } = await supabase.rpc('person_names', { p_ids: ids })
        setNames(new Map(((n ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name])))
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal memuat rutin.')
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void supabase.rpc('can_fill_routine').then(({ data }) => setCanFill(data === true))
    void supabase.rpc('can_edit_routine').then(({ data }) => setCanEdit(data === true))
  }, [])

  if (!profile) return null
  if (!catalog) return error ? <p className="error">{error}</p> : <Skeleton />
  const canReopen = canFill && (profile.role === 'manager' || profile.role === 'developer')

  async function removeRoutine(t: Template) {
    if (!window.confirm(`Hapus rutinitas "${t.name}"? Hanya bisa selama belum ada isian.`)) return
    const { error: rpcError } = await supabase.rpc('deactivate_routine', { p_key: t.key })
    if (rpcError) return setError(rpcError.message)
    await load()
  }

  if (building) {
    return <RoutineBuilder onClose={() => setBuilding(false)} onCreated={() => { setBuilding(false); void load() }} />
  }

  if (open) {
    const items = catalog.items.filter((i) => i.template_id === open.template.id)
    const subjects = catalog.subjects.filter((s) => s.template_id === open.template.id)
    if (open.run) {
      return (
        <RoutineReport key={open.run.id} template={open.template} items={items} subjects={subjects} run={open.run}
          inspectorName={names.get(open.run.inspector_id) ?? '-'} canReopen={canReopen}
          onClose={() => setOpen(null)} onChanged={() => void load()} />
      )
    }
    return (
      <RoutineForm key={`${open.template.key}-new`} template={open.template} items={items} subjects={subjects}
        doneSubjects={done.get(open.template.id) ?? new Set()} userId={profile.id} period={open.period} onClose={() => setOpen(null)} onChanged={() => void load()} />
    )
  }

  const cards = catalog.templates.map((t) => {
    const period = currentPeriod(t)
    const perSubject = t.mode === 'per_subject'
    const run = perSubject ? undefined : runs.find((r) => r.template_id === t.id && r.period === period)
    const doneSet = done.get(t.id) ?? new Set<number>()
    const items = catalog.items.filter((i) => i.template_id === t.id)
    const subjects = catalog.subjects.filter((s) => s.template_id === t.id)
    const exp = expectedKeys(items, perSubject ? subjects.filter((x) => !doneSet.has(x.id)) : subjects)
    const draft = run ? null : loadDraft(profile.id, t.key, period)
    const draftSubjects = perSubject && draft ? subjects.filter((x) => draft.picked.includes(x.id)) : subjects
    const filled = draft ? expectedKeys(items, draftSubjects).filter((e) => isAnswered(e.item, draft.answers[e.key])).length : 0
    const label = t.frequency === 'weekly' ? `Minggu ini (${fmtDay(period)} – ${fmtDay(addDaysStr(period, 6))})` : 'Hari ini'
    return { t, period, run, filled, total: exp.length, label, perSubject, doneCount: doneSet.size, roomTotal: subjects.length, picked: draft?.picked.length ?? 0 }
  })

  return (
    <>
      <div className="row">
        <h2 className="title">Rutin tim ME</h2>
        {canEdit && <button type="button" className="chip add" onClick={() => setBuilding(true)}>+ Tambah rutinitas</button>}
      </div>
      <p className="meta">{canFill ? 'Genset: satu checklist per hari untuk seluruh tim. Panel dan Room: tiap anggota memeriksa panel atau kamar yang berbeda dan mengirimnya satu per satu.' : 'Anda dapat melihat hasil rutin tim ME. Pengisian oleh tim ME.'}</p>
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {cards.map(({ t, period, run, filled, total, label, perSubject, doneCount, roomTotal, picked }) => (
          <li key={t.id} className="item">
            <button type="button" className="card" onClick={() => (perSubject ? canFill && doneCount < roomTotal && setOpen({ template: t, period }) : (run || canFill) && setOpen({ template: t, run, period }))}>
              <div className="row">
                <strong>{t.name} · {t.frequency === 'weekly' ? 'Mingguan' : 'Harian'}</strong>
                {perSubject ? (
                  <span className={doneCount >= roomTotal ? 'tag ap-approved' : 'tag ap-pending'}>
                    {doneCount >= roomTotal ? 'Semua selesai' : picked > 0 ? `${doneCount}/${roomTotal} ${t.subject_noun} · draf ${picked}` : `${doneCount}/${roomTotal} ${t.subject_noun}`}
                  </span>
                ) : run ? (
                  <span className={run.ng_count ? 'tag ap-rejected' : 'tag ap-approved'}>{run.ng_count ? `${run.ng_count} NG` : 'Semua OK'}</span>
                ) : (
                  <span className="tag ap-pending">{filled > 0 ? `Draf ${filled}/${total}` : 'Belum diisi'}</span>
                )}
              </div>
              <div className="meta">{label}</div>
              <div className="meta">
                {perSubject
                  ? (doneCount >= roomTotal ? `Semua ${t.subject_noun} sudah diperiksa ${t.frequency === 'weekly' ? 'minggu ini' : 'hari ini'}` : canFill ? `Ketuk untuk memeriksa ${t.subject_noun} (boleh sebagian, sisanya bisa dikerjakan rekan tim)` : 'Menunggu tim ME')
                  : run ? `Selesai oleh ${names.get(run.inspector_id) ?? '-'} · ${fmtTime(run.submitted_at)}` : canFill ? 'Ketuk untuk mengisi' : 'Menunggu tim ME'}
              </div>
            </button>
            {canEdit && t.created_by && !runs.some((r) => r.template_id === t.id) && (
              <div className="item-actions">
                <button type="button" className="ghost review" onClick={() => void removeRoutine(t)}>Hapus rutinitas</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <h3 className="section">Riwayat terbaru</h3>
      {runs.length === 0 && <p className="hint">Belum ada isian.</p>}
      <ul className="list">
        {runs.slice(0, 15).map((r) => {
          const t = catalog.templates.find((x) => x.id === r.template_id)
          if (!t) return null
          return (
            <li key={r.id} className="item">
              <button type="button" className="card" onClick={() => setOpen({ template: t, run: r, period: r.period })}>
                <div className="row">
                  <strong>{t.name}</strong>
                  <span className={r.ng_count ? 'tag ap-rejected' : 'tag ap-approved'}>{r.ng_count ? `${r.ng_count} NG` : 'OK'}</span>
                </div>
                <div className="meta">{fmtDay(r.period)} · {names.get(r.inspector_id) ?? '-'} · {fmtTime(r.submitted_at)}</div>
                {roomsOf.get(r.id) && <div className="meta">Diperiksa: {[...(roomsOf.get(r.id) ?? [])].sort((a, b) => a.localeCompare(b, 'id', { numeric: true })).join(', ')}</div>}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
