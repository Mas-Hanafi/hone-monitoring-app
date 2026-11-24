import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useRealtime } from '../lib/realtime'
import { todayWib, weekRange } from '../lib/date'
import { ACTIVE_STATUSES } from '../lib/types'
import { summarize, type DashTask } from '../lib/stats'
import type { Preset } from './Tasks'

const SELECT =
  'id, title, status, progress, is_urgent, deadline, last_update_at, pic:profiles!tasks_pic_id_fkey(full_name), ' +
  'req:departments!tasks_requester_department_id_fkey(name)'
const ROW_LIMIT = 1000 // batas baris Data API

interface Row {
  id: string; title: string; status: string; progress: number; is_urgent: boolean
  deadline: string; last_update_at: string
  pic: { full_name: string } | null
  req: { name: string } | null
}

interface DeptStat { name: string; proses: number; belum: number; hold: number; selesai: number }

interface RoutineStat {
  key: string; name: string; frequency: 'daily' | 'weekly'; mode: 'whole' | 'per_subject'; noun: string
  done: boolean; by?: string; at?: string; ng: number; checked: number; total: number
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false })

// Status checklist rutin tim ME untuk periode berjalan (hari ini untuk harian, minggu ini untuk mingguan)
async function loadRoutine(): Promise<RoutineStat[]> {
  const today = todayWib()
  const week = weekRange(today).start
  const [t, runs, rs, subj] = await Promise.all([
    supabase.from('routine_templates').select('id, key, name, frequency, mode, subject_noun').eq('is_active', true).order('sort'),
    supabase.from('routine_runs')
      .select('template_id, period, submitted_at, ng_count, inspector:profiles!routine_runs_inspector_id_fkey(full_name)')
      .in('period', [today, week]).order('submitted_at', { ascending: false }).limit(200),
    supabase.from('routine_run_subjects').select('template_id, period').in('period', [today, week]).limit(500),
    supabase.from('routine_subjects').select('template_id').eq('is_active', true).limit(500),
  ])
  if (t.error || runs.error || rs.error || subj.error) return []
  type Run = { template_id: number; period: string; submitted_at: string; ng_count: number; inspector: { full_name: string } | null }
  const allRuns = (runs.data ?? []) as unknown as Run[]
  return (t.data ?? []).map((tp) => {
    const period = tp.frequency === 'weekly' ? week : today
    const mine = allRuns.filter((r) => r.template_id === tp.id && r.period === period)
    const checked = (rs.data ?? []).filter((r) => r.template_id === tp.id && r.period === period).length
    const total = (subj.data ?? []).filter((r) => r.template_id === tp.id).length
    const last = mine[0]
    return {
      key: tp.key, name: tp.name, frequency: tp.frequency, mode: tp.mode, noun: tp.subject_noun,
      done: tp.mode === 'per_subject' ? total > 0 && checked >= total : mine.length > 0,
      by: last?.inspector?.full_name, at: last?.submitted_at, ng: mine.reduce((n, r) => n + r.ng_count, 0), checked, total,
    } as RoutineStat
  })
}

// Semua pengguna aktif melihat tugas tim ME (lihat kebijakan tasks_read).
export function Dashboard({ onOpen }: { onOpen: (p: Preset | null) => void }) {
  const [tasks, setTasks] = useState<DashTask[]>([])
  const [depts, setDepts] = useState<DeptStat[]>([])
  const [routine, setRoutine] = useState<RoutineStat[]>([])
  const [doneThisMonth, setDoneThisMonth] = useState(0)
  const [toReview, setToReview] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    setError('')
    const monthStart = `${todayWib().slice(0, 8)}01T00:00:00+07:00`
    const [active, done, review, rt] = await Promise.all([
      supabase.from('tasks').select(SELECT).in('status', ACTIVE_STATUSES).limit(ROW_LIMIT),
      supabase.from('tasks').select('id, req:departments!tasks_requester_department_id_fkey(name)')
        .in('status', ['done', 'handover']).gte('completed_at', monthStart).limit(ROW_LIMIT),
      supabase.from('tasks').select('id', { count: 'exact', head: true })
        .in('status', ['done', 'handover']).eq('approval', 'pending'),
      loadRoutine(),
    ])
    if (active.error || done.error || review.error) {
      setError((active.error ?? done.error ?? review.error)?.message ?? 'Gagal memuat')
    } else {
      const rows = active.data as unknown as Row[]
      const doneRows = done.data as unknown as { id: string; req: { name: string } | null }[]
      setTruncated(rows.length >= ROW_LIMIT)
      setDoneThisMonth(doneRows.length)
      setToReview(review.count ?? 0)
      setTasks(rows.map((r) => ({
        id: r.id, title: r.title, status: r.status, progress: r.progress, is_urgent: r.is_urgent,
        deadline: r.deadline, last_update_at: r.last_update_at, pic_name: r.pic?.full_name ?? '-',
      })))
      const map = new Map<string, DeptStat>()
      const stat = (name: string) => {
        let s = map.get(name)
        if (!s) { s = { name, proses: 0, belum: 0, hold: 0, selesai: 0 }; map.set(name, s) }
        return s
      }
      for (const r of rows) {
        const s = stat(r.req?.name ?? 'Tanpa departemen')
        if (r.status === 'in_progress') s.proses++
        else if (r.status === 'not_started') s.belum++
        else if (r.status === 'on_hold') s.hold++
      }
      for (const r of doneRows) stat(r.req?.name ?? 'Tanpa departemen').selesai++
      setDepts([...map.values()].sort((a, b) => (b.proses + b.belum + b.hold) - (a.proses + a.belum + a.hold) || a.name.localeCompare(b.name)))
      setRoutine(rt)
    }
    setLoadedAt(Date.now())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useRealtime('tasks', () => load(true))

  const summary = useMemo(() => summarize(tasks, todayWib(), loadedAt), [tasks, loadedAt])
  const { kpi, attention } = summary

  return (
    <>
      <div className="row">
        <h2 className="title">Ringkasan</h2>
        <button type="button" className="ghost" onClick={() => load()} disabled={loading}>
          {loading ? 'Memuat…' : 'Segarkan'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {truncated && <p className="error">Data dipotong di {ROW_LIMIT} tugas aktif; angka bisa kurang.</p>}

      <div className="kpis">
        <button type="button" className="tile" onClick={() => onOpen(null)}><b>{kpi.active}</b><span>Tugas aktif</span></button>
        <button type="button" className={kpi.urgent ? 'tile warn' : 'tile'} onClick={() => onOpen('urgent')}><b>{kpi.urgent}</b><span>Urgent</span></button>
        <button type="button" className={kpi.late ? 'tile bad' : 'tile'} onClick={() => onOpen('late')}><b>{kpi.late}</b><span>Terlambat</span></button>
        <button type="button" className={kpi.stale ? 'tile warn' : 'tile'} onClick={() => onOpen('stale')}><b>{kpi.stale}</b><span>Macet &gt; 3 hari</span></button>
        <button type="button" className={toReview ? 'tile warn' : 'tile'} onClick={() => onOpen('review')}><b>{toReview}</b><span>Menunggu approval</span></button>
        <button type="button" className="tile ok" onClick={() => onOpen('done_month')}><b>{doneThisMonth}</b><span>Selesai bulan ini</span></button>
      </div>

      <h3 className="section">Checklist rutin tim ME</h3>
      {routine.length === 0 && !loading && <p className="hint">Data checklist belum tersedia.</p>}
      <ul className="list">
        {routine.map((r) => {
          const partial = r.mode === 'per_subject' && r.checked > 0 && !r.done
          return (
            <li key={r.key} className="panel">
              <div className="row">
                <strong>{r.name} · {r.frequency === 'weekly' ? 'minggu ini' : 'hari ini'}</strong>
                <span className={r.done ? 'tag ap-approved' : partial ? 'tag ap-hold' : 'tag urgent'}>
                  {r.mode === 'per_subject'
                    ? `${r.checked}/${r.total} ${r.noun}`
                    : r.done ? 'Sudah diisi' : 'Belum diisi'}
                </span>
              </div>
              <span className="meta">
                {r.at && r.by ? `Terakhir diisi ${r.by} pukul ${hhmm(r.at)} WIB` : r.done ? '' : 'Belum ada isian pada periode ini'}
                {r.ng > 0 ? ` · ${r.ng} temuan NG` : ''}
              </span>
            </li>
          )
        })}
      </ul>

      <h3 className="section">Per departemen peminta</h3>
      {depts.length === 0 && !loading && <p className="hint">Belum ada tugas.</p>}
      {depts.length > 0 && (
        <div className="panel dept-table" role="table" aria-label="Tugas per departemen peminta">
          <div className="dept-row dept-head" role="row">
            <span role="columnheader">Departemen</span>
            <span role="columnheader">Proses</span>
            <span role="columnheader">Belum</span>
            <span role="columnheader">Hold</span>
            <span role="columnheader">Selesai</span>
          </div>
          {depts.map((d) => (
            <div key={d.name} className="dept-row" role="row">
              <strong role="cell">{d.name}</strong>
              <span role="cell">{d.proses}</span>
              <span role="cell" className={d.belum ? 'dept-warn' : ''}>{d.belum}</span>
              <span role="cell">{d.hold}</span>
              <span role="cell" className="dept-ok">{d.selesai}</span>
            </div>
          ))}
          <p className="meta">Proses = sedang dikerjakan. Belum = belum dimulai. Selesai = selesai bulan ini.</p>
        </div>
      )}

      <h3 className="section">Perlu perhatian</h3>
      {attention.length === 0 && !loading && <p className="hint">Tidak ada tugas terlambat atau macet.</p>}
      <ul className="list">
        {attention.map((a) => (
          <li key={a.id} className="panel">
            <strong>{a.title}</strong>
            <span className="meta">PIC {a.pic}</span>
            <div className="reasons">
              {a.reasons.map((r) => <span key={r} className="tag urgent">{r}</span>)}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
