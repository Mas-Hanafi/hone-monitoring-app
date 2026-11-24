import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ProgressSheet } from '../components/ProgressSheet'
import { CreateTaskSheet } from '../components/CreateTaskSheet'
import { ApprovalSheet } from '../components/ApprovalSheet'
import { ManageSheet } from '../components/ManageSheet'
import { PhotoSheet } from '../components/PhotoSheet'
import { addDaysStr, todayWib } from '../lib/date'
import { STALE_DAYS } from '../lib/stats'
import { cacheGet, cachePut, useOutbox } from '../lib/offline'
import { classifyRpcError } from '../lib/queue'
import { useRealtime } from '../lib/realtime'
import { Icon } from '../components/Icon'
import { Skeleton } from '../components/Skeleton'
import {
  ACTIVE_STATUSES,
  APPROVAL_LABEL,
  CLOSED_STATUSES,
  CREATOR_ROLES,
  STATUS_LABEL,
  type Task,
} from '../lib/types'

const SELECT =
  'id, task_no, title, status, approval, pic_id, pic_department_id, requester_department_id, progress, is_urgent, deadline, original_deadline, latest_note, last_update_at, ' +
  'pic:profiles!tasks_pic_id_fkey(full_name), dept:departments!tasks_pic_department_id_fkey(name), ' +
  'req:departments!tasks_requester_department_id_fkey(name)'

type Mode = 'active' | 'closed' | 'review'

// Dibuka dari kartu Ringkasan: daftar langsung tersaring sesuai angka yang diketuk
export type Preset = 'urgent' | 'late' | 'stale' | 'done_month' | 'review'
const PRESET_LABEL: Record<Preset, string> = {
  urgent: 'Urgent', late: 'Terlambat', stale: `Macet > ${STALE_DAYS} hari`, done_month: 'Selesai bulan ini', review: 'Menunggu approval',
}
const modeFor = (p: Preset): Mode => (p === 'review' ? 'review' : p === 'done_month' ? 'closed' : 'active')

export function Tasks({ preset: presetProp = null }: { preset?: Preset | null }) {
  const { profile } = useAuth()
  const [preset, setPreset] = useState<Preset | null>(presetProp)
  const [mode, setModeRaw] = useState<Mode>(() => (presetProp ? modeFor(presetProp) : 'active'))
  const setMode = (m: Mode) => { setPreset(null); setModeRaw(m) }
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Task | null>(null)
  const [reviewing, setReviewing] = useState<Task | null>(null)
  const [managing, setManaging] = useState<Task | null>(null)
  const [photos, setPhotos] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)
  const [staleAt, setStaleAt] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()) // departemen yang dilipat
  const { items: outbox } = useOutbox(profile?.id)
  const pendingIds = new Set(outbox.filter((i) => i.state === 'pending').map((i) => i.taskId))
  const pendingCount = pendingIds.size
  const prevPending = useRef(pendingCount)

  // quiet = muat ulang diam-diam (perubahan realtime): tanpa kedip "Memuat…"
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    setError('')
    let query = supabase.from('tasks').select(SELECT)
    if (mode === 'active') query = query.in('status', ACTIVE_STATUSES)
    else if (mode === 'closed') query = query.in('status', CLOSED_STATUSES)
    else query = query.in('status', ['done', 'handover']).eq('approval', 'pending')
    const today0 = todayWib()
    if (preset === 'urgent') query = query.eq('is_urgent', true)
    else if (preset === 'late') query = query.lt('deadline', today0)
    else if (preset === 'stale') query = query.neq('status', 'on_hold').lte('last_update_at', new Date(Date.now() - (STALE_DAYS + 1) * 86_400_000).toISOString())
    else if (preset === 'done_month') query = query.gte('completed_at', `${today0.slice(0, 8)}01T00:00:00+07:00`)
    // Aktif/perlu approval: deadline terdekat di atas (yang sudah lewat otomatis paling atas); Selesai: urgent dulu seperti semula
    if (mode === 'closed') query = query.order('is_urgent', { ascending: false }).order('deadline', { ascending: true })
    else query = query.order('deadline', { ascending: true }).order('is_urgent', { ascending: false })
    const { data, error: qError } = await query.limit(200)
    const cacheKey = `tasks:${profile?.id}:${mode}:${preset ?? ''}`
    if (qError) {
      if (classifyRpcError(qError).kind === 'transient') {
        // Tanpa sinyal: tampilkan salinan terakhir supaya tugas tetap bisa dipilih dan dilaporkan
        const cached = await cacheGet<Task[]>(cacheKey)
        if (cached) {
          setTasks(cached.value)
          setStaleAt(cached.savedAt)
        } else {
          setError('Tidak ada koneksi dan belum ada data tersimpan.')
        }
      } else {
        setError(qError.message)
      }
    } else {
      setTasks(data as unknown as Task[])
      setStaleAt(null)
      void cachePut(cacheKey, data)
    }
    setLoading(false)
  }, [mode, preset, profile?.id])

  useEffect(() => {
    load()
  }, [load])

  // Status berubah di HP orang lain => daftar ikut berubah tanpa refresh
  useRealtime('tasks', () => load(true))

  // Setelah update offline berhasil terkirim, muat ulang daftar
  useEffect(() => {
    if (prevPending.current > pendingCount) load()
    prevPending.current = pendingCount
  }, [pendingCount, load])

  if (!profile) return null
  const today = todayWib()
  const soonUntil = addDaysStr(today, 3)
  const isCreator = CREATOR_ROLES.includes(profile.role)
  // Sama dengan aturan set_approval: bukan yang dibatalkan; menilai tugas sendiri hanya Developer dan Manager/SPV tim ME
  // Manager/Developer: semua. SPV: tugas tim ME (dept PIC) atau tugas yang departemennya minta.
  const isLead = profile.role === 'manager' || profile.role === 'developer'
  const inMyTeam = (t: Task) => t.pic_department_id === profile.department_id
  const canReview = (t: Task) =>
    isCreator && t.status !== 'cancelled' && (t.pic_id !== profile.id || profile.role === 'developer' || inMyTeam(t)) &&
    (isLead || inMyTeam(t) || t.requester_department_id === profile.department_id)

  // Tim ME mengerjakan tugas bersama: semua anggota ME (termasuk staff) bisa lapor progress dan handover PIC.
  // Peminta dari departemen lain hanya melihat dan menilai.
  const canManage = (t: Task) => ACTIVE_STATUSES.includes(t.status) && (isLead || inMyTeam(t))
  const canUpdate = (t: Task) => t.pic_id === profile.id || isLead || inMyTeam(t)

  // Dikelompokkan per departemen peminta; urutan departemen mengikuti tugas dengan deadline paling dekat
  const groups: { name: string; items: Task[] }[] = []
  for (const t of tasks) {
    const name = t.req?.name ?? 'Tanpa departemen'
    let g = groups.find((x) => x.name === name)
    if (!g) { g = { name, items: [] }; groups.push(g) }
    g.items.push(t)
  }
  const count = (list: Task[], status: Task['status']) => list.filter((t) => t.status === status).length

  const renderTask = (t: Task) => {
          const isActive = ACTIVE_STATUSES.includes(t.status)
          const overdue = isActive && t.deadline < today
          const dueSoon = isActive && !overdue && t.deadline <= soonUntil   // H-3 sampai H-0
          const showApproval = t.approval !== 'pending' || t.status === 'done' || t.status === 'handover'
          return (
            <li key={t.id} className="item">
              <button type="button" className={overdue ? 'card due-late' : dueSoon ? 'card due-soon' : 'card'} onClick={() => canUpdate(t) && setSelected(t)}>
                <div className="row">
                  <strong>{t.title}</strong>
                  <span className="tags">
                    {pendingIds.has(t.id) && <span className="tag ap-pending">Menunggu terkirim</span>}
                    {showApproval && <span className={`tag ap-${t.approval}`}>{APPROVAL_LABEL[t.approval]}</span>}
                    {t.is_urgent && <span className="tag urgent">Urgent</span>}
                  </span>
                </div>
                <div className="meta">
                  TSK-{String(t.task_no).padStart(4, '0')} · Dari {t.req?.name ?? '-'} · PIC {t.pic?.full_name ?? '-'}
                </div>
                <div className="bar">
                  <span style={{ width: `${t.progress}%` }} />
                </div>
                <div className="row meta">
                  <span>
                    {STATUS_LABEL[t.status]} · {t.progress}%
                  </span>
                  <span className={overdue ? 'late' : ''}>
                    {overdue ? 'Terlambat · ' : 'Deadline '}
                    {t.deadline}
                  </span>
                </div>
                {t.latest_note && <div className="note">{t.latest_note}</div>}
              </button>
              {(isCreator || canManage(t)) && (
                <div className="item-actions">
                  <button type="button" className="ghost review" onClick={() => setPhotos(t)}>
                    <Icon name="camera" /> Foto
                  </button>
                  {canManage(t) && (
                    <button type="button" className="ghost review" onClick={() => setManaging(t)}>
                      <Icon name="edit" /> Ubah
                    </button>
                  )}
                  {canReview(t) && (
                    <button type="button" className="ghost review" onClick={() => setReviewing(t)}>
                      <Icon name="check" /> Nilai
                    </button>
                  )}
                </div>
              )}
            </li>
          )
  }

  return (
    <>
      <div className="chips tabs">
        <button type="button" className={mode === 'active' ? 'chip on' : 'chip'} onClick={() => setMode('active')}>
          Aktif
        </button>
        <button type="button" className={mode === 'closed' ? 'chip on' : 'chip'} onClick={() => setMode('closed')}>
          Selesai
        </button>
        {isCreator && (
          <button type="button" className={mode === 'review' ? 'chip on' : 'chip'} onClick={() => setMode('review')}>
            Perlu approval
          </button>
        )}
        {isCreator && (
          <button type="button" className="chip add" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> Tugas
          </button>
        )}
      </div>

      {preset && (
        <div className="chips">
          <button type="button" className="chip on" onClick={() => setPreset(null)} aria-label={`Hapus filter ${PRESET_LABEL[preset]}`}>
            Filter: {PRESET_LABEL[preset]} ✕
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {staleAt && (
        <p className="hint">
          Offline: menampilkan data terakhir dimuat {new Date(staleAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}.
        </p>
      )}
      {tasks.length >= 200 && (
        <p className="hint">Menampilkan 200 tugas teratas. Tugas lain tidak tampil di daftar ini; gunakan Laporan untuk data lengkap.</p>
      )}
      {loading && tasks.length === 0 && <Skeleton />}
      {!loading && !error && tasks.length === 0 && <p className="hint">Tidak ada tugas.</p>}

      {tasks.length > 0 && (
        <p className="meta">
          {tasks.length} tugas dari {groups.length} departemen
          {mode === 'active' ? ` · ${count(tasks, 'in_progress')} proses · ${count(tasks, 'not_started')} belum dimulai${count(tasks, 'on_hold') ? ` · ${count(tasks, 'on_hold')} hold` : ''}` : ''}
          {mode === 'closed' ? ` · ${count(tasks, 'done') + count(tasks, 'handover')} selesai${count(tasks, 'cancelled') ? ` · ${count(tasks, 'cancelled')} dibatalkan` : ''}` : ''}
        </p>
      )}
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.name)
        return (
          <section key={g.name} className="grp">
            <button type="button" className="grp-head" aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((cur) => { const n = new Set(cur); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n })}>
              <strong>{g.name}</strong>
              <span className="tags">
                {mode === 'active' && <>
                  <span className="tag">{count(g.items, 'in_progress')} proses</span>
                  <span className="tag">{count(g.items, 'not_started')} belum dimulai</span>
                  {count(g.items, 'on_hold') > 0 && <span className="tag">{count(g.items, 'on_hold')} hold</span>}
                </>}
                {mode === 'closed' && <>
                  <span className="tag">{count(g.items, 'done') + count(g.items, 'handover')} selesai</span>
                  {count(g.items, 'cancelled') > 0 && <span className="tag">{count(g.items, 'cancelled')} dibatalkan</span>}
                </>}
                {mode === 'review' && <span className="tag">{g.items.length} perlu dinilai</span>}
              </span>
              <span className="grp-caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
            </button>
            {!isCollapsed && <ul className="list">{g.items.map(renderTask)}</ul>}
          </section>
        )
      })}

      {creating && (
        <CreateTaskSheet
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            setMode('active')
            load()
          }}
        />
      )}

      {selected && (
        <ProgressSheet
          task={selected}
          role={profile.role}
          userName={profile.full_name}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null)
            load()
          }}
        />
      )}

      {managing && (
        <ManageSheet
          task={managing}
          onClose={() => setManaging(null)}
          onSaved={() => {
            setManaging(null)
            load()
          }}
        />
      )}

      {photos && <PhotoSheet task={photos} onClose={() => setPhotos(null)} />}

      {reviewing && (
        <ApprovalSheet
          task={reviewing}
          onClose={() => setReviewing(null)}
          onSaved={() => {
            setReviewing(null)
            load()
          }}
        />
      )}
    </>
  )
}
