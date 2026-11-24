import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { todayWib } from '../lib/date'

// Kalender kaca (diadaptasi dari "Glass Calendar"): nama bulan besar, panah bulan, deretan hari bergulir
// atau kisi bulan, tanggal terpilih bergradasi, titik "hari ini". Tanpa library (CSS di glass.css, kelas .dp-*).
// Nilai selalu string: 'YYYY-MM-DD' (DatePicker) atau 'YYYY-MM' (MonthPicker), zona WIB seperti bagian lain app.

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d: d || 1 } }
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const mondayIndex = (y: number, m: number, d: number) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
const fmt = (opts: Intl.DateTimeFormatOptions, y: number, m: number, d = 1) =>
  new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', ...opts }).format(new Date(Date.UTC(y, m - 1, d)))
const INITIALS = ['S', 'S', 'R', 'K', 'J', 'S', 'M'] // Senin..Minggu
const clampYm = (ym: { y: number; m: number }, min?: string, max?: string) => {
  const v = ym.y * 12 + ym.m
  const lo = min ? parse(min).y * 12 + parse(min).m : -Infinity
  const hi = max ? parse(max).y * 12 + parse(max).m : Infinity
  const c = Math.min(hi, Math.max(lo, v))
  return { y: Math.floor((c - 1) / 12), m: ((c - 1) % 12) + 1 }
}

function Icon({ children }: { children: ReactNode }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}
const Chevron = ({ dir }: { dir: 'l' | 'r' }) => <Icon><path d={dir === 'l' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} /></Icon>
const CalIcon = () => <Icon><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></Icon>

// Lapisan modal di body (portal): bar/panel kaca memakai backdrop-filter yang membuat elemen fixed "terjebak"
function Overlay({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="dp-overlay" onClick={onClose}>
      <div className="dp-card" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

type DateProps = { id: string; label: string; value: string; onChange: (v: string) => void; min?: string; max?: string }

export function DatePicker({ id, label, value, onChange, min, max }: DateProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'strip' | 'grid'>('strip')
  const today = todayWib()
  const start = value || today
  const [ym, setYm] = useState(() => clampYm({ y: parse(start).y, m: parse(start).m }, min, max))
  const selRef = useRef<HTMLButtonElement>(null)

  const openIt = () => { setYm(clampYm({ y: parse(value || today).y, m: parse(value || today).m }, min, max)); setOpen(true) }
  const off = (s: string) => (!!min && s < min) || (!!max && s > max)
  const days = useMemo(() => Array.from({ length: dim(ym.y, ym.m) }, (_, i) => ymd(ym.y, ym.m, i + 1)), [ym])
  const blanks = mondayIndex(ym.y, ym.m, 1)

  useEffect(() => {
    if (open) selRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [open, ym, view])

  const go = (delta: number) => setYm((c) => { const v = c.y * 12 + (c.m - 1) + delta; return { y: Math.floor(v / 12), m: (v % 12) + 1 } })
  const pick = (s: string) => { if (off(s)) return; onChange(s); setOpen(false) }

  const dayBtn = (s: string) => {
    const { d } = parse(s)
    const cls = ['dp-day', s === value ? 'sel' : '', s === today && s !== value ? 'today' : ''].join(' ')
    return (
      <button key={s} type="button" ref={s === value ? selRef : undefined} className={cls} disabled={off(s)}
        aria-label={fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, parse(s).y, parse(s).m, d)}
        aria-pressed={s === value} onClick={() => pick(s)}>
        {d}
      </button>
    )
  }

  return (
    <>
      <label className="field" htmlFor={id}>{label}</label>
      <button id={id} type="button" className="dp-trigger" onClick={openIt} aria-haspopup="dialog">
        <span>{value ? fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, parse(value).y, parse(value).m, parse(value).d) : 'Pilih tanggal'}</span>
        <CalIcon />
      </button>
      {open && (
        <Overlay onClose={() => setOpen(false)} label={label}>
          <div className="dp-top">
            <div className="dp-seg" role="group" aria-label="Tampilan kalender">
              <button type="button" aria-pressed={view === 'strip'} onClick={() => setView('strip')}>Geser</button>
              <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Kalender</button>
            </div>
            <button type="button" className="dp-close" onClick={() => setOpen(false)} aria-label="Tutup kalender">✕</button>
          </div>
          <div className="dp-head">
            <p key={`${ym.y}-${ym.m}`} className="dp-month">
              {fmt({ month: 'long' }, ym.y, ym.m)} <span>{ym.y}</span>
            </p>
            <div className="dp-nav">
              <button type="button" onClick={() => go(-1)} aria-label="Bulan sebelumnya"><Chevron dir="l" /></button>
              <button type="button" onClick={() => go(1)} aria-label="Bulan berikutnya"><Chevron dir="r" /></button>
            </div>
          </div>
          {view === 'strip' ? (
            <div className="dp-strip">
              {days.map((s) => (
                <div key={s} className="dp-col">
                  <span>{INITIALS[mondayIndex(parse(s).y, parse(s).m, parse(s).d)]}</span>
                  {dayBtn(s)}
                </div>
              ))}
            </div>
          ) : (
            <div className="dp-grid">
              {INITIALS.map((c, i) => <span key={i} className="dp-dow">{c}</span>)}
              {Array.from({ length: blanks }, (_, i) => <i key={`b${i}`} />)}
              {days.map(dayBtn)}
            </div>
          )}
          <div className="dp-foot">
            <button type="button" className="dp-link" disabled={off(today)} onClick={() => pick(today)}>Hari ini</button>
            <span className="dp-hint">{value ? '' : 'Belum dipilih'}</span>
          </div>
        </Overlay>
      )}
    </>
  )
}

type RangeProps = {
  id: string; label: string; from: string; to: string; max?: string
  onChange: (from: string, to: string) => void
}

// Rentang tanggal: seret dari tanggal awal ke akhir (mouse atau jari), atau ketuk dua kali (awal, lalu akhir).
// Lepas = rentang langsung terpilih. Bisa pindah bulan di antara dua ketukan.
export function RangePicker({ id, label, from, to, max, onChange }: RangeProps) {
  const [open, setOpen] = useState(false)
  const today = todayWib()
  const [ym, setYm] = useState(() => ({ y: parse(from || today).y, m: parse(from || today).m }))
  const [draft, setDraft] = useState<{ a: string; b: string } | null>(null) // pratinjau saat menyeret / menunggu ketukan kedua
  const drag = useRef<{ a: string; moved: boolean } | null>(null)
  const pending = useRef<string | null>(null) // tanggal awal dari ketukan pertama

  const off = (s: string) => !!max && s > max
  const days = useMemo(() => Array.from({ length: dim(ym.y, ym.m) }, (_, i) => ymd(ym.y, ym.m, i + 1)), [ym])
  const blanks = mondayIndex(ym.y, ym.m, 1)
  const go = (delta: number) => setYm((c) => { const v = c.y * 12 + (c.m - 1) + delta; return { y: Math.floor(v / 12), m: (v % 12) + 1 } })

  const openIt = () => {
    setYm({ y: parse(from || today).y, m: parse(from || today).m })
    setDraft(null); pending.current = null; drag.current = null
    setOpen(true)
  }
  const close = () => { setOpen(false); setDraft(null); pending.current = null; drag.current = null }
  const commit = (a: string, b: string) => { onChange(a <= b ? a : b, a <= b ? b : a); close() }

  const dayAt = (x: number, y: number) => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-d]')
    const d = el?.dataset.d
    return d && !off(d) ? d : null
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dayAt(e.clientX, e.clientY)
    if (!d) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { a: d, moved: false }
    setDraft({ a: pending.current ?? d, b: d })
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current
    if (!g) return
    const d = dayAt(e.clientX, e.clientY)
    if (!d) return
    if (d !== g.a) g.moved = true
    if (g.moved) { pending.current = null; setDraft({ a: g.a, b: d }) }
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current
    drag.current = null
    if (!g) return
    const d = dayAt(e.clientX, e.clientY) ?? g.a
    if (g.moved && d !== g.a) return commit(g.a, d) // seret
    if (pending.current) return commit(pending.current, g.a) // ketukan kedua
    pending.current = g.a // ketukan pertama
    setDraft({ a: g.a, b: g.a })
  }
  const onCancel = () => { drag.current = null; setDraft(pending.current ? { a: pending.current, b: pending.current } : null) }
  // Keyboard (Enter/Spasi pada tombol tanggal): tanpa pointer, detail klik = 0
  const onKeyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.detail !== 0) return
    const d = (e.target as HTMLElement).closest<HTMLElement>('[data-d]')?.dataset.d
    if (!d || off(d)) return
    if (pending.current) return commit(pending.current, d)
    pending.current = d
    setDraft({ a: d, b: d })
  }

  const lo = draft ? (draft.a <= draft.b ? draft.a : draft.b) : from
  const hi = draft ? (draft.a <= draft.b ? draft.b : draft.a) : to
  const span = lo && hi ? Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000) + 1 : 0
  const short = (s: string) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }, parse(s).y, parse(s).m, parse(s).d)

  return (
    <>
      <label className="field" htmlFor={id}>{label}</label>
      <button id={id} type="button" className="dp-trigger" onClick={openIt} aria-haspopup="dialog">
        <span>{from && to ? `${short(from)}  –  ${short(to)}` : 'Pilih rentang tanggal'}</span>
        <CalIcon />
      </button>
      {open && (
        <Overlay onClose={close} label={label}>
          <div className="dp-top">
            <span className="dp-hint">{pending.current ? 'Pilih tanggal akhir' : 'Seret atau ketuk tanggal awal lalu akhir'}</span>
            <button type="button" className="dp-close" onClick={close} aria-label="Tutup kalender">✕</button>
          </div>
          <div className="dp-head">
            <p key={`${ym.y}-${ym.m}`} className="dp-month">
              {fmt({ month: 'long' }, ym.y, ym.m)} <span>{ym.y}</span>
            </p>
            <div className="dp-nav">
              <button type="button" onClick={() => go(-1)} aria-label="Bulan sebelumnya"><Chevron dir="l" /></button>
              <button type="button" onClick={() => go(1)} aria-label="Bulan berikutnya"><Chevron dir="r" /></button>
            </div>
          </div>
          <div className="dp-grid dp-range" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onPointerCancel={onCancel} onClick={onKeyClick}>
            {INITIALS.map((c, i) => <span key={i} className="dp-dow">{c}</span>)}
            {Array.from({ length: blanks }, (_, i) => <i key={`b${i}`} />)}
            {days.map((s) => {
              const cls = ['dp-day', s === lo || s === hi ? 'sel' : '', s > lo && s < hi ? 'in' : '', s === today && s !== lo && s !== hi ? 'today' : ''].join(' ')
              return (
                <button key={s} type="button" data-d={s} className={cls} disabled={off(s)}
                  aria-label={fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, parse(s).y, parse(s).m, parse(s).d)}>
                  {parse(s).d}
                </button>
              )
            })}
          </div>
          <div className="dp-foot">
            <span className="dp-hint">{lo && hi ? `${short(lo)} – ${short(hi)} · ${span} hari` : 'Belum dipilih'}</span>
          </div>
        </Overlay>
      )}
    </>
  )
}

type MonthProps = { id: string; label: string; value: string; onChange: (v: string) => void; max?: string }

export function MonthPicker({ id, label, value, onChange, max }: MonthProps) {
  const [open, setOpen] = useState(false)
  const thisMonth = todayWib().slice(0, 7)
  const [year, setYear] = useState(() => parse(value ? `${value}-01` : todayWib()).y)
  const maxYm = max ?? ''
  const off = (ym: string) => !!maxYm && ym > maxYm

  return (
    <>
      <label className="field" htmlFor={id}>{label}</label>
      <button id={id} type="button" className="dp-trigger" aria-haspopup="dialog"
        onClick={() => { setYear(parse(value ? `${value}-01` : todayWib()).y); setOpen(true) }}>
        <span>{value ? `${fmt({ month: 'long' }, parse(`${value}-01`).y, parse(`${value}-01`).m)} ${parse(`${value}-01`).y}` : 'Pilih bulan'}</span>
        <CalIcon />
      </button>
      {open && (
        <Overlay onClose={() => setOpen(false)} label={label}>
          <div className="dp-top">
            <span className="dp-hint">Pilih bulan</span>
            <button type="button" className="dp-close" onClick={() => setOpen(false)} aria-label="Tutup kalender">✕</button>
          </div>
          <div className="dp-head">
            <p key={year} className="dp-month">{year}</p>
            <div className="dp-nav">
              <button type="button" onClick={() => setYear((y) => y - 1)} aria-label="Tahun sebelumnya"><Chevron dir="l" /></button>
              <button type="button" onClick={() => setYear((y) => y + 1)} aria-label="Tahun berikutnya"><Chevron dir="r" /></button>
            </div>
          </div>
          <div className="dp-months">
            {Array.from({ length: 12 }, (_, i) => {
              const ym = `${year}-${pad(i + 1)}`
              const cls = ['dp-mon', ym === value ? 'sel' : '', ym === thisMonth && ym !== value ? 'today' : ''].join(' ')
              return (
                <button key={ym} type="button" className={cls} disabled={off(ym)} aria-pressed={ym === value}
                  onClick={() => { onChange(ym); setOpen(false) }}>
                  {fmt({ month: 'short' }, year, i + 1)}
                </button>
              )
            })}
          </div>
        </Overlay>
      )}
    </>
  )
}
