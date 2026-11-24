import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { addDaysStr, monthRange, prevMonth, todayWib, weekRange } from '../lib/date'
import { countRows, type Counts, type ExportRow } from '../lib/report'
import { STATUS_LABEL } from '../lib/types'
import { MonthPicker, RangePicker } from '../components/DatePicker'
import { fmtDate } from '../lib/pdfReport'

const PAGE = 500 // export_tasks maksimal 1000 baris per halaman (batas Data API)
const MAX_PAGES = 50

type Kind = 'range' | 'month'
const MAX_SPAN_DAYS = 366 // satu laporan maksimal setahun, supaya tetap cepat dimuat

async function fetchAll(start: string, end: string): Promise<ExportRow[]> {
  const all: ExportRow[] = []
  let after = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await supabase.rpc('export_tasks', {
      p_start: start, p_end: end, p_after: after, p_limit: PAGE,
    })
    if (error) throw new Error(error.message)
    const page = (data ?? []) as ExportRow[]
    all.push(...page)
    if (page.length < PAGE) return all
    after = page[page.length - 1].task_no
  }
  throw new Error('Terlalu banyak data untuk satu laporan.')
}

// SPV: hanya departemennya. Manager/Developer: semua. Dibatasi di database (export_tasks), bukan di sini.
export function Reports() {
  const { profile } = useAuth()
  const canClose = profile?.role === 'manager' || profile?.role === 'developer'
  const today = todayWib()

  const [kind, setKind] = useState<Kind>('range')
  const [from, setFrom] = useState(() => addDaysStr(todayWib(), -6)) // bawaan: 7 hari terakhir
  const [to, setTo] = useState(() => todayWib())
  const [month, setMonth] = useState(() => prevMonth(todayWib()))
  const [rows, setRows] = useState<ExportRow[] | null>(null)
  const [loaded, setLoaded] = useState<{ start: string; end: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const [closedMonths, setClosedMonths] = useState<string[]>([])
  const [closeMonth, setCloseMonth] = useState(() => prevMonth(todayWib()))
  const [closing, setClosing] = useState(false)
  const [closeMsg, setCloseMsg] = useState('')

  const range = kind === 'range' ? { start: from, end: to } : monthRange(month)
  const spanDays = range.start && range.end ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1 : 0
  const rangeError =
    kind !== 'range' ? '' :
    !from || !to ? 'Isi tanggal Dari dan Sampai.' :
    from > to ? 'Tanggal "Dari" tidak boleh sesudah "Sampai".' :
    to > today ? 'Tanggal "Sampai" tidak boleh di masa depan.' :
    spanDays > MAX_SPAN_DAYS ? `Rentang maksimal ${MAX_SPAN_DAYS} hari (sekarang ${spanDays} hari).` : ''
  const monthMissing = kind === 'month' && !month
  const quick = (start: string, end: string) => { setFrom(start); setTo(end); setRows(null) }
  const counts: Counts | null = rows && loaded ? countRows(rows, loaded.end) : null

  const loadClosed = useCallback(async () => {
    if (!canClose) return
    const { data } = await supabase.from('monthly_snapshots').select('period').order('period', { ascending: false })
    setClosedMonths((data ?? []).map((r: { period: string }) => r.period))
  }, [canClose])

  useEffect(() => {
    loadClosed()
  }, [loadClosed])

  async function handleLoad() {
    setLoading(true)
    setError('')
    setRows(null)
    try {
      setRows(await fetchAll(range.start, range.end))
      setLoaded(range)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal memuat laporan.')
    }
    setLoading(false)
  }

  // Laporan PDF memakai kop surat perusahaan. Pustaka PDF dan gambar kop dimuat saat tombol ditekan.
  async function makePdf(name: string, title: string, subtitle: string, list: ExportRow[], periodEnd: string): Promise<void> {
    const [{ buildReportPdf }, logo, line] = await Promise.all([
      import('../lib/pdfReport'),
      import('../assets/kop/logo.png?inline'),
      import('../assets/kop/line.png?inline'),
    ])
    const doc = await buildReportPdf({
      title, subtitle, rows: list, periodEnd, statusLabel: STATUS_LABEL,
      author: profile?.full_name ?? '-', printedAt: new Date(), assets: { logo: logo.default, line: line.default },
    })
    doc.save(name)
  }

  async function savePdf() {
    if (!rows || !loaded) return
    setExporting(true)
    setError('')
    try {
      await makePdf(`Laporan-Tugas-ME_${loaded.start}_${loaded.end}.pdf`, 'LAPORAN TUGAS TIM ME',
        `Periode ${fmtDate(loaded.start)} s/d ${fmtDate(loaded.end)}`, rows, loaded.end)
    } catch (e: unknown) {
      setError(e instanceof Error ? `Gagal membuat PDF: ${e.message}` : 'Gagal membuat PDF.')
    }
    setExporting(false)
  }

  const closeRange = monthRange(closeMonth)
  const isClosed = closedMonths.includes(closeMonth)
  const hasEnded = closeRange.end < today

  async function handleClose() {
    setCloseMsg('')
    if (!window.confirm(`Tutup bulan ${closeMonth}? Rekap dibekukan dan TIDAK bisa diubah atau dibuka lagi.`)) return
    setClosing(true)
    const { error: rpcError } = await supabase.rpc('close_month', { p_period: closeMonth })
    setClosing(false)
    if (rpcError) return setCloseMsg(rpcError.message)
    setCloseMsg(`Bulan ${closeMonth} sudah ditutup.`)
    loadClosed()
  }

  async function saveSnapshot() {
    setCloseMsg('')
    const { data, error: qError } = await supabase.from('monthly_snapshots').select('rows').eq('period', closeMonth).single()
    if (qError) return setCloseMsg(qError.message)
    setExporting(true)
    try {
      await makePdf(`Rekap-Resmi-Tugas-ME_${closeMonth}.pdf`, 'REKAP RESMI TUGAS TIM ME',
        `Bulan ${fmtDate(closeRange.start)} s/d ${fmtDate(closeRange.end)} (sudah ditutup)`, (data as { rows: ExportRow[] }).rows, closeRange.end)
    } catch (e: unknown) {
      setCloseMsg(e instanceof Error ? `Gagal membuat PDF: ${e.message}` : 'Gagal membuat PDF.')
    }
    setExporting(false)
  }

  return (
    <>
      <h2 className="title">Laporan</h2>
      <p className="meta">Laporan diunduh sebagai PDF dengan kop surat perusahaan.</p>

      <div className="chips">
        <button type="button" className={kind === 'range' ? 'chip on' : 'chip'} onClick={() => setKind('range')}>Rentang tanggal</button>
        <button type="button" className={kind === 'month' ? 'chip on' : 'chip'} onClick={() => setKind('month')}>Bulanan</button>
      </div>

      {kind === 'range' ? (
        <>
          <div className="chips">
            <button type="button" className="chip" onClick={() => quick(addDaysStr(today, -6), today)}>7 hari terakhir</button>
            <button type="button" className="chip" onClick={() => { const w = weekRange(addDaysStr(weekRange(today).start, -7)); quick(w.start, w.end) }}>Minggu lalu</button>
            <button type="button" className="chip" onClick={() => quick(`${today.slice(0, 8)}01`, today)}>Bulan ini</button>
          </div>
          <RangePicker id="rp-range" label="Rentang tanggal" max={today} from={from} to={to}
            onChange={(a, b) => { setFrom(a); setTo(b); setRows(null) }} />
        </>
      ) : (
        <>
          <MonthPicker id="rp-month" label="Bulan" max={today.slice(0, 7)} value={month} onChange={setMonth} />
        </>
      )}
      {rangeError
        ? <p className="error">{rangeError}</p>
        : <p className="meta">Periode: {range.start} s/d {range.end}{kind === 'range' ? ` (${spanDays} hari, WIB)` : ' (tanggal 1 sampai akhir bulan, WIB)'}</p>}

      <button type="button" className="primary" onClick={handleLoad} disabled={loading || !!rangeError || monthMissing || !range.start}>
        {loading ? 'Memuat…' : 'Muat laporan'}
      </button>
      {error && <p className="error">{error}</p>}

      {counts && loaded && (
        <>
          <div className="kpis">
            <div className="tile"><b>{counts.total}</b><span>Total tugas</span></div>
            <div className="tile ok"><b>{counts.finished}</b><span>Selesai</span></div>
            <div className="tile"><b>{counts.active}</b><span>Aktif</span></div>
            <div className={counts.late ? 'tile bad' : 'tile'}><b>{counts.late}</b><span>Terlambat</span></div>
            <div className="tile"><b>{counts.cancelled}</b><span>Dibatalkan</span></div>
          </div>
          {counts.total === 0 ? (
            <p className="hint">Tidak ada tugas pada periode ini.</p>
          ) : (
            <div className="actions left">
              <button type="button" className="primary" onClick={() => void savePdf()} disabled={exporting}>
                {exporting ? 'Membuat PDF…' : 'Unduh laporan (PDF)'}
              </button>
            </div>
          )}
          <p className="meta">Angka mengikuti keadaan di akhir periode ({loaded.end}), bukan keadaan hari ini.</p>
        </>
      )}

      {canClose && (
        <>
          <h3 className="section">Tutup bulan</h3>
          <p className="meta">
            Membekukan rekap bulanan untuk dilaporkan ke GM/owner. Setelah ditutup, angkanya tidak berubah
            walau data dikoreksi kemudian, dan tidak bisa dibuka lagi.
          </p>
          <MonthPicker id="rp-close" label="Bulan" max={today.slice(0, 7)} value={closeMonth}
            onChange={(v) => { setCloseMonth(v); setCloseMsg('') }} />
          <div className="actions left">
            <button type="button" className="primary" onClick={handleClose}
              disabled={closing || isClosed || !hasEnded || !closeMonth}>
              {closing ? 'Menutup…' : isClosed ? 'Sudah ditutup' : 'Tutup bulan'}
            </button>
            {isClosed && <button type="button" className="ghost" onClick={() => void saveSnapshot()} disabled={exporting}>{exporting ? 'Membuat PDF…' : 'Unduh rekap resmi (PDF)'}</button>}
          </div>
          {!hasEnded && closeMonth && <p className="hint">Bulan ini belum berakhir; baru bisa ditutup setelah tanggal {closeRange.end}.</p>}
          {closeMsg && <p className={closeMsg.startsWith('Bulan') ? 'hint' : 'error'}>{closeMsg}</p>}
          {closedMonths.length > 0 && <p className="meta">Sudah ditutup: {closedMonths.join(', ')}</p>}
        </>
      )}
    </>
  )
}
