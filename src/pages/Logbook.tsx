import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useRealtime } from '../lib/realtime'
import { DatePicker } from '../components/DatePicker'
import { Skeleton } from '../components/Skeleton'
import { addDaysStr, todayWib } from '../lib/date'
import {
  currentShift, EDIT_WINDOW_DAYS, ENTRY_COLUMNS, hhmm, nowTimeWib, shiftLabel, SHIFTS,
  type Entry, type Revision, type ShiftKey, type Status,
} from '../lib/logbook'

const fmtStamp = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const fmtShort = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })

type Names = Map<string, string>

// Logbook shift tim ME sekaligus serah terima (handover) antar shift. Semua anggota ME boleh menambah dan mengubah
// catatan siapa pun; pembuat, pengubah, dan penyelesai selalu tercatat, isi lama tersimpan sebagai revisi.
// Pekerjaan yang ditandai "perlu dilanjutkan" tampil di daftar teratas sampai ada yang menandainya selesai.
// Pimpinan di luar ME hanya membaca.
export function Logbook() {
  const { profile } = useAuth()
  const [date, setDate] = useState(() => currentShift().date)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [openList, setOpenList] = useState<Entry[]>([])
  const [names, setNames] = useState<Names>(new Map())
  const [canFill, setCanFill] = useState(false)
  const [error, setError] = useState('')
  const now = currentShift()
  const today = todayWib()

  const load = useCallback(async () => {
    const [day, open] = await Promise.all([
      supabase.from('logbook_entries').select(ENTRY_COLUMNS).eq('entry_date', date)
        .order('entry_time', { ascending: true, nullsFirst: false }).order('created_at').limit(300),
      supabase.from('logbook_entries').select(ENTRY_COLUMNS).eq('status', 'open')
        .order('entry_date', { ascending: true }).order('created_at').limit(100),
    ])
    const e = day.error ?? open.error
    if (e) return setError(e.message)
    setError('')
    const list = (day.data ?? []) as Entry[]
    const openRows = (open.data ?? []) as Entry[]
    setEntries(list)
    setOpenList(openRows)
    const ids = [...new Set([...list, ...openRows].flatMap((x) => [x.created_by, x.updated_by, x.closed_by]).filter((x): x is string => !!x))]
    if (ids.length) {
      const { data: n } = await supabase.rpc('person_names', { p_ids: ids })
      setNames(new Map(((n ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name])))
    }
  }, [date])

  useEffect(() => { setEntries(null); void load() }, [load])
  useEffect(() => { void supabase.rpc('can_fill_routine').then(({ data }) => setCanFill(data === true)) }, [])
  useRealtime('logbook_entries', () => void load())

  const byShift = useMemo(() => {
    const m: Record<ShiftKey, Entry[]> = { morning: [], evening: [], night: [] }
    for (const e of entries ?? []) m[e.shift].push(e)
    return m
  }, [entries])

  if (!profile) return null
  const lockedBefore = addDaysStr(today, -EDIT_WINDOW_DAYS)
  const editable = date >= lockedBefore

  return (
    <>
      <h2 className="title">Logbook shift ME</h2>
      <p className="meta">
        Catatan kegiatan dan serah terima antar shift. {canFill ? 'Semua anggota ME boleh menambah dan mengubah; pembuat dan pengubah tercatat.' : 'Anda dapat melihat logbook tim ME.'}
      </p>

      {openList.length > 0 && (
        <section className="lb-open" aria-label="Perlu dilanjutkan">
          <h3 className="section">Perlu dilanjutkan ({openList.length})</h3>
          <p className="meta">Pekerjaan yang belum selesai dari shift sebelumnya. Hilang dari daftar ini setelah ditandai selesai.</p>
          <ul className="list">
            {openList.map((e) => (
              <EntryCard key={e.id} entry={e} names={names} canEdit={canFill} onSaved={load}
                heading={<>{fmtShort(e.entry_date)} · {shiftLabel(e.shift)}{e.entry_time ? ` · ${hhmm(e.entry_time)}` : ''}</>}
                onOpenDay={e.entry_date !== date ? () => setDate(e.entry_date) : undefined} />
            ))}
          </ul>
        </section>
      )}

      <div className="lb-nav">
        <button type="button" className="ghost" onClick={() => setDate(addDaysStr(date, -1))} aria-label="Hari sebelumnya">←</button>
        <div className="lb-date">
          <DatePicker id="lb-date" label="Tanggal" value={date} max={addDaysStr(today, 1)} onChange={(v) => setDate(v)} />
        </div>
        <button type="button" className="ghost" onClick={() => setDate(addDaysStr(date, 1))} disabled={date >= addDaysStr(today, 1)} aria-label="Hari berikutnya">→</button>
      </div>
      <p className="meta">{fmtDay(date)}{date !== now.date ? <> · <button type="button" className="link" onClick={() => setDate(now.date)}>ke shift sekarang</button></> : ''}</p>
      {!editable && canFill && <p className="hint">Catatan selesai yang lebih dari {EDIT_WINDOW_DAYS} hari terkunci. Pekerjaan yang masih perlu dilanjutkan tetap bisa diubah dan diselesaikan.</p>}
      {error && <p className="error">{error}</p>}
      {entries === null && !error && <Skeleton />}

      {entries !== null && SHIFTS.map((s) => (
        <section key={s.key} className={`lb-shift${date === now.date && s.key === now.shift ? ' now' : ''}`}>
          <div className="row">
            <h3 className="section">{s.label}</h3>
            <span className="meta">{s.hours}{date === now.date && s.key === now.shift ? ' · berjalan' : ''}</span>
          </div>
          {byShift[s.key].length === 0 && <p className="hint">Belum ada catatan.</p>}
          <ul className="list">
            {byShift[s.key].map((e) => (
              <EntryCard key={e.id} entry={e} names={names} canEdit={canFill && (editable || e.status === 'open')} onSaved={load} />
            ))}
          </ul>
          {canFill && editable && <AddForm date={date} shift={s.key} defaultTime={date === now.date && s.key === now.shift ? nowTimeWib() : ''} onSaved={load} />}
        </section>
      ))}
    </>
  )
}

function AddForm({ date, shift, defaultTime, onSaved }: { date: string; shift: ShiftKey; defaultTime: string; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [time, setTime] = useState(defaultTime)
  const [body, setBody] = useState('')
  const [carry, setCarry] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setBusy(true); setError('')
    const { error: rpcError } = await supabase.rpc('add_logbook_entry', {
      p_date: date, p_shift: shift, p_time: time || null, p_body: body, p_status: carry ? 'open' : 'done',
    })
    setBusy(false)
    if (rpcError) return setError(rpcError.message)
    setBody(''); setCarry(false); setOpen(false)
    await onSaved()
  }

  if (!open) return <button type="button" className="chip add lb-add" onClick={() => { setTime(defaultTime || nowTimeWib()); setOpen(true) }}>+ Tambah kegiatan</button>
  return (
    <div className="lb-form">
      <label className="field" htmlFor={`lb-t-${shift}`}>Jam (opsional)</label>
      <input id={`lb-t-${shift}`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      <label className="field" htmlFor={`lb-b-${shift}`}>Kegiatan</label>
      <textarea id={`lb-b-${shift}`} rows={3} maxLength={2000} value={body} autoFocus onChange={(e) => setBody(e.target.value)} placeholder="Apa yang dikerjakan atau ditemukan…" />
      <label className="check"><input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} /> Belum selesai, perlu dilanjutkan shift berikutnya</label>
      {error && <p className="error">{error}</p>}
      <div className="actions left">
        <button type="button" className="primary" disabled={busy || !body.trim()} onClick={save}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
        <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>Batal</button>
      </div>
    </div>
  )
}

function EntryCard({ entry: e, names, canEdit, onSaved, heading, onOpenDay }: {
  entry: Entry; names: Names; canEdit: boolean; onSaved: () => Promise<void>; heading?: React.ReactNode; onOpenDay?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [time, setTime] = useState(hhmm(e.entry_time))
  const [body, setBody] = useState(e.body)
  const [carry, setCarry] = useState(e.status === 'open')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [baseRev, setBaseRev] = useState(e.revisions) // jumlah revisi saat form Ubah dibuka: dasar pengecekan tabrakan
  const [history, setHistory] = useState<Revision[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const who = (id: string | null) => (id ? names.get(id) ?? '-' : '-')

  useEffect(() => { if (!editing) { setTime(hhmm(e.entry_time)); setBody(e.body); setCarry(e.status === 'open') } }, [e, editing])

  async function send(nextBody: string, nextTime: string, status: Status, expectedRev: number) {
    setBusy(true); setError('')
    const { error: rpcError } = await supabase.rpc('edit_logbook_entry', {
      p_id: e.id, p_time: nextTime || null, p_body: nextBody, p_status: status, p_expected_revisions: expectedRev,
    })
    setBusy(false)
    if (rpcError) {
      setError(rpcError.message)
      if (/diubah orang lain/.test(rpcError.message)) await onSaved() // tampilkan versi terbaru; teks yang sedang diketik tetap aman di form
      return
    }
    setEditing(false); setHistory(null)
    await onSaved()
  }

  async function toggleHistory() {
    const next = !showHistory
    setShowHistory(next)
    if (next && !history) {
      const { data } = await supabase.from('logbook_revisions').select('id, entry_time, body, status, edited_by, edited_at').eq('entry_id', e.id).order('id')
      const rows = (data ?? []) as Revision[]
      const { data: n } = await supabase.rpc('person_names', { p_ids: [...new Set(rows.map((r) => r.edited_by))] })
      const nm = new Map(((n ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name]))
      setHistory(rows.map((r) => ({ ...r, edited_by: nm.get(r.edited_by) ?? '-' })))
    }
  }

  return (
    <li className={`item lb-entry${e.status === 'open' ? ' open' : ''}`}>
      {editing ? (
        <div className="lb-form">
          <input type="time" value={time} onChange={(ev) => setTime(ev.target.value)} aria-label="Jam" />
          <textarea rows={3} maxLength={2000} value={body} onChange={(ev) => setBody(ev.target.value)} aria-label="Kegiatan" />
          <label className="check"><input type="checkbox" checked={carry} onChange={(ev) => setCarry(ev.target.checked)} /> Masih perlu dilanjutkan shift berikutnya</label>
          {error && <p className="error">{error}</p>}
          <div className="actions left">
            <button type="button" className="primary" disabled={busy || !body.trim()} onClick={() => send(body, time, carry ? 'open' : 'done', baseRev)}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
            <button type="button" className="ghost" onClick={() => { setEditing(false); setError('') }} disabled={busy}>Batal</button>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            <strong>{heading ?? (e.entry_time ? hhmm(e.entry_time) : 'Tanpa jam')}</strong>
            {e.status === 'open' ? <span className="tag urgent">Perlu dilanjutkan</span> : e.closed_by ? <span className="tag ap-approved">Selesai</span> : null}
          </div>
          <p className="lb-body">{e.body}</p>
          <div className="lb-trace meta">
            <div>Dicatat oleh <strong>{who(e.created_by)}</strong> · {fmtStamp(e.created_at)}</div>
            {e.revisions > 0 && (
              <div>
                Terakhir diubah oleh <strong>{who(e.updated_by)}</strong> · {e.updated_at ? fmtStamp(e.updated_at) : ''} ·{' '}
                <button type="button" className="link" onClick={toggleHistory}>{showHistory ? 'Sembunyikan riwayat' : `Riwayat (${e.revisions})`}</button>
              </div>
            )}
            {e.status === 'done' && e.closed_by && <div>Diselesaikan oleh <strong>{who(e.closed_by)}</strong> · {e.closed_at ? fmtStamp(e.closed_at) : ''}</div>}
          </div>
          {showHistory && (
            <ul className="lb-history">
              {(history ?? []).map((r) => (
                <li key={r.id}><span className="meta">{fmtStamp(r.edited_at)} · {r.edited_by} mengubah dari{r.status === 'open' ? ' (perlu dilanjutkan)' : ''}:</span> {r.entry_time ? `${hhmm(r.entry_time)} · ` : ''}{r.body}</li>
              ))}
              {!history && <li className="meta">Memuat…</li>}
            </ul>
          )}
          {error && <p className="error">{error}</p>}
          {(canEdit || onOpenDay) && (
            <div className="actions left lb-actions">
              {canEdit && e.status === 'open' && <button type="button" className="primary" disabled={busy} onClick={() => send(e.body, hhmm(e.entry_time), 'done', e.revisions)}>Tandai selesai</button>}
              {canEdit && <button type="button" className="ghost" onClick={() => { setBaseRev(e.revisions); setEditing(true) }}>Ubah</button>}
              {canEdit && e.status === 'done' && e.closed_by && <button type="button" className="ghost" disabled={busy} onClick={() => send(e.body, hhmm(e.entry_time), 'open', e.revisions)}>Buka lagi</button>}
              {onOpenDay && <button type="button" className="ghost" onClick={onOpenDay}>Buka harinya</button>}
            </div>
          )}
        </>
      )}
    </li>
  )
}
