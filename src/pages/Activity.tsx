import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { addDaysStr, todayWib } from '../lib/date'
import { RangePicker } from '../components/DatePicker'
import { Skeleton } from '../components/Skeleton'

type Row = { happened_at: string; actor_id: string | null; actor_name: string; kind: string; summary: string; detail: string | null }

const PAGE = 100
const KINDS: { key: string; label: string }[] = [
  { key: '', label: 'Semua jenis' },
  { key: 'task', label: 'Tugas' },
  { key: 'routine', label: 'Rutin' },
  { key: 'logbook', label: 'Logbook' },
  { key: 'admin', label: 'Pengguna' },
  { key: 'export', label: 'Ekspor' },
]
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]))

const wib = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', ...opts }).format(new Date(iso))
const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(iso))
const wibStart = (date: string) => `${date}T00:00:00+07:00`

// Semua akun aktif bisa melihat (hanya baca). Jenis "Pengguna" dan "Ekspor" hanya untuk Developer (ditegakkan di database).
export function Activity() {
  const { profile } = useAuth()
  const isDev = profile?.role === 'developer'
  const [rows, setRows] = useState<Row[]>([])
  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([])
  const [actor, setActor] = useState('')
  const [kind, setKind] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const today = todayWib()

  useEffect(() => {
    supabase.rpc('list_people').then(({ data }) => setPeople((data ?? []) as { id: string; full_name: string }[]))
  }, [])
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(search.trim()), 350)
    return () => window.clearTimeout(id)
  }, [search])

  const fetchPage = useCallback(async (before: string | null) => {
    const { data, error: e } = await supabase.rpc('activity_feed', {
      p_before: before,
      p_actor: actor || null,
      p_kind: kind || null,
      p_from: range ? wibStart(range.from) : null,
      p_to: range ? wibStart(addDaysStr(range.to, 1)) : null,
      p_search: query || null,
      p_limit: PAGE,
    })
    if (e) throw new Error(e.message)
    return (data ?? []) as Row[]
  }, [actor, kind, range, query])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(null)
      setRows(page)
      setMore(page.length === PAGE)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat')
    }
    setLoading(false)
  }, [fetchPage])
  useEffect(() => {
    void load()
  }, [load])

  async function loadMore() {
    if (!rows.length) return
    setLoading(true)
    try {
      const page = await fetchPage(rows[rows.length - 1].happened_at)
      setRows((cur) => [...cur, ...page])
      setMore(page.length === PAGE)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat')
    }
    setLoading(false)
  }

  const pick = (from: string, to: string) => { setRange({ from, to }); setPicking(false) }
  const groups: { day: string; items: Row[] }[] = []
  for (const r of rows) {
    const d = dayKey(r.happened_at)
    const last = groups[groups.length - 1]
    if (last && last.day === d) last.items.push(r)
    else groups.push({ day: d, items: [r] })
  }

  return (
    <>
      <div className="row">
        <h2 className="title">Log Activity</h2>
        <button type="button" className="ghost" onClick={() => void load()}>Muat ulang</button>
      </div>
      <p className="hint">Catatan perubahan tugas, rutin, dan logbook oleh semua akun. Hanya untuk dilihat, tidak bisa diubah.{isDev ? ' Anda (developer) juga melihat perubahan akun dan ekspor.' : ''} Login dan keluar akun tidak dicatat.</p>

      <div className="chips">
        <button type="button" className={!range && !picking ? 'chip on' : 'chip'} onClick={() => { setRange(null); setPicking(false) }}>Semua waktu</button>
        <button type="button" className={range?.from === today && range.to === today ? 'chip on' : 'chip'} onClick={() => pick(today, today)}>Hari ini</button>
        <button type="button" className="chip" onClick={() => pick(addDaysStr(today, -6), today)}>7 hari</button>
        <button type="button" className={picking ? 'chip on' : 'chip'} onClick={() => { setPicking(true); setRange((r) => r ?? { from: today, to: today }) }}>Pilih tanggal</button>
      </div>
      {picking && range && (
        <RangePicker id="act-range" label="Rentang tanggal" max={today} from={range.from} to={range.to} onChange={(a, b) => setRange({ from: a, to: b })} />
      )}

      <div className="chips">
        <select aria-label="Akun" value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">Semua akun</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </select>
        <select aria-label="Jenis" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.filter((k) => isDev || (k.key !== 'admin' && k.key !== 'export')).map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
      </div>
      <input type="search" placeholder="Cari nama, nomor tugas (TSK-0004), kata kunci" value={search} onChange={(e) => setSearch(e.target.value)} />

      {error && <p className="error">{error}</p>}
      {loading && rows.length === 0 && <Skeleton rows={6} />}
      {!loading && !error && rows.length === 0 && <p className="hint">Tidak ada aktivitas yang cocok.</p>}

      {groups.map((g) => (
        <section key={g.day} className="act-day">
          <h3 className="act-head">{wib(g.items[0].happened_at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
          <ul className="list">
            {g.items.map((r, i) => (
              <li key={`${r.happened_at}-${i}`} className="item">
                <div className="card act-card">
                  <div className="row">
                    <span><strong>{r.actor_name}</strong> {r.summary}</span>
                  </div>
                  {r.detail && <div className="note">{r.detail}</div>}
                  <div className="meta">
                    {wib(r.happened_at, { hour: '2-digit', minute: '2-digit', hour12: false })} WIB · <span className="tag role">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more && (
        <button type="button" className="ghost" disabled={loading} onClick={() => void loadMore()}>
          {loading ? 'Memuat…' : 'Muat yang lebih lama'}
        </button>
      )}
    </>
  )
}
