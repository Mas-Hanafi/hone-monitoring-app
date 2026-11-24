// Laporan PDF (A4 tegak) memakai kop surat perusahaan (isi konstanta COMPANY, ADDRESS, EMAIL, PHONE di bawah) dari "Template Export.docx":
// logo kiri atas, nama perusahaan dan alamat di tengah, baris email/WhatsApp, lalu garis hijau-biru di bawahnya.
// Kop diulang di setiap halaman, seperti header pada templatenya. Ukuran dan posisi mengikuti berkas Word (margin 1 inci).
// Pustaka PDF dimuat saat dibutuhkan (dynamic import) supaya tidak membebani muat awal app.
import { buildRecap, countRows, type ExportRow } from './report.ts'

export interface PdfAssets { logo: string; line: string } // data URI PNG

export interface PdfOptions {
  title: string               // contoh: LAPORAN TUGAS TIM ME
  subtitle: string            // contoh: Periode 1 Nov 2026 s/d 30 Nov 2026
  rows: ExportRow[]
  periodEnd: string           // YYYY-MM-DD, dasar hitungan "terlambat"
  statusLabel: Record<string, string>
  author: string
  printedAt: Date
  assets: PdfAssets
}

// ---- ukuran halaman (mm), mengikuti template ----
const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 25.4                  // 1 inci kiri/kanan
const TEXT_W = PAGE_W - 2 * MARGIN   // 159,2 mm
const CX = PAGE_W / 2
const LOGO = { x: MARGIN + 1.0, y: 12.97, w: 35.19, h: 14.62 }
const COMPANY = 'H ONE'
const COMPANY2 = '(HOSPITALITY)'
const ADDRESS = 'Alamat: Jalan Contoh No. 1, Kota Contoh, Provinsi Contoh 00000'
const EMAIL = 'hello@hone.example'
const PHONE = '0800-0000-0000'
export const BODY_TOP = 56           // isi mulai di bawah kop
const BODY_BOTTOM = 22               // sisakan ruang untuk nomor halaman
const PT = 0.3528                    // 1 pt dalam mm

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
export const fmtDate = (d: string | null | undefined): string => {
  if (!d) return '-'
  const [y, m, day] = d.split('-').map(Number)
  return `${day} ${MONTHS[m - 1] ?? '?'} ${y}`
}
const wibStamp = (d: Date): string =>
  new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/\./g, ':')

type Doc = import('jspdf').jsPDF

// Kecilkan huruf bila teks lebih lebar dari ruang yang tersedia (font bawaan PDF lebih lebar daripada Calibri pada templatenya)
function fit(doc: Doc, text: string, max: number, start: number, min = 8): number {
  let size = start
  doc.setFontSize(size)
  while (doc.getTextWidth(text) > max && size > min) {
    size -= 0.25
    doc.setFontSize(size)
  }
  return size
}

function drawKop(doc: Doc, a: PdfAssets): void {
  doc.addImage(a.logo, 'PNG', LOGO.x, LOGO.y, LOGO.w, LOGO.h)
  doc.setTextColor(0, 0, 0)

  doc.setFont('helvetica', 'bold')
  const maxTitle = 2 * (CX - (LOGO.x + LOGO.w + 3)) // jangan menabrak logo
  const t1 = fit(doc, COMPANY, maxTitle, 20, 12)
  let y = 19.8
  doc.text(COMPANY, CX, y, { align: 'center' })
  y += t1 * PT * 1.22
  doc.setFontSize(t1)
  doc.text(COMPANY2, CX, y, { align: 'center' })

  fit(doc, ADDRESS, TEXT_W, 12)
  y += 6.2
  doc.text(ADDRESS, CX, y, { align: 'center' })

  // Email (biru bergaris bawah, tautan mailto) | WhatsApp
  doc.setFont('helvetica', 'normal')
  const lead = 'Email: '
  const tail = ` | Whatsapp : ${PHONE}`
  const full = `${lead}${EMAIL}${tail}`
  const sz = fit(doc, full, TEXT_W, 12)
  const leadW = doc.getTextWidth(lead)
  const emailW = doc.getTextWidth(EMAIL)
  const total = doc.getTextWidth(full)
  const x0 = CX - total / 2
  y += sz * PT * 1.25
  doc.text(lead, x0, y)
  doc.setTextColor(4, 98, 193) // 0462C1
  doc.text(EMAIL, x0 + leadW, y)
  doc.setDrawColor(4, 98, 193)
  doc.setLineWidth(0.2)
  doc.line(x0 + leadW, y + 0.7, x0 + leadW + emailW, y + 0.7)
  doc.link(x0 + leadW, y - sz * PT, emailW, sz * PT + 1, { url: `mailto:${EMAIL}` })
  doc.setTextColor(0, 0, 0)
  doc.text(tail, x0 + leadW + emailW, y)

  // garis hijau-biru di bawah kop (lebar area teks)
  doc.addImage(a.line, 'PNG', MARGIN, y + 3.2, TEXT_W, 3.175)
}

function drawFooter(doc: Doc, left: string, page: number, pages: number): void {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(110, 110, 110)
  doc.text(left, MARGIN, PAGE_H - 12)
  doc.text(`Halaman ${page} dari ${pages}`, PAGE_W - MARGIN, PAGE_H - 12, { align: 'right' })
  doc.setTextColor(0, 0, 0)
}

const HEAD = { fillColor: [38, 94, 140] as [number, number, number], textColor: 255, fontStyle: 'bold' as const, halign: 'center' as const, valign: 'middle' as const }
const BASE = { font: 'helvetica', fontSize: 7.5, cellPadding: 1.3, lineColor: [190, 198, 206] as [number, number, number], lineWidth: 0.15, textColor: [30, 30, 30] as [number, number, number], overflow: 'linebreak' as const }
const ALT = { fillColor: [244, 247, 250] as [number, number, number] }

export async function buildReportPdf(o: PdfOptions): Promise<Doc> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = autoTableMod.default
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  doc.setProperties({ title: `${o.title} - ${o.subtitle}`, author: o.author, creator: 'H One Monitoring Apps' })

  let y = BODY_TOP
  const ensure = (need: number) => {
    if (y + need > PAGE_H - BODY_BOTTOM) {
      doc.addPage()
      y = BODY_TOP
    }
  }

  // Judul
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(o.title, CX, y, { align: 'center' })
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(o.subtitle, CX, y, { align: 'center' })
  y += 7

  // Ringkasan angka
  const c = countRows(o.rows, o.periodEnd)
  autoTable(doc, {
    startY: y, margin: { top: BODY_TOP, left: MARGIN, right: MARGIN, bottom: BODY_BOTTOM }, theme: 'grid',
    head: [['Total tugas', 'Selesai', 'Aktif', 'Terlambat', 'Dibatalkan', 'Urgent']],
    body: [[c.total, c.finished, c.active, c.late, c.cancelled, c.urgent].map(String)],
    styles: { ...BASE, fontSize: 9, halign: 'center', cellPadding: 2 }, headStyles: HEAD,
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8

  // Rekap per PIC
  ensure(30)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10.5)
  doc.text('Rekap per PIC', MARGIN, y)
  y += 2.5
  const recap = buildRecap(o.rows, o.periodEnd)
  autoTable(doc, {
    startY: y, margin: { top: BODY_TOP, left: MARGIN, right: MARGIN, bottom: BODY_BOTTOM }, theme: 'grid',
    head: [recap.headers], body: recap.body.map((r) => r.map((x) => (x == null ? '' : String(x)))),
    styles: BASE, headStyles: HEAD, alternateRowStyles: ALT,
    columnStyles: { 0: { cellWidth: 28 }, 1: { cellWidth: 25 }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'center' }, 6: { halign: 'center' }, 7: { halign: 'center' }, 8: { halign: 'center' } },
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8

  // Rincian tugas
  ensure(30)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10.5)
  doc.text('Rincian tugas', MARGIN, y)
  y += 2.5
  const body = o.rows.map((r) => [
    `TSK-${String(r.task_no).padStart(4, '0')}`,
    `${r.title}${r.urgency === 'Urgent' ? '  [URGENT]' : ''}`,
    r.requester,
    r.pic,
    [o.statusLabel[r.status] ?? r.status, r.approval && r.approval !== 'Pending' ? `Approval: ${r.approval}` : '', r.completed_on ? fmtDate(r.completed_on) : ''].filter(Boolean).join('\n'),
    `${r.progress_start ?? 0}-${r.progress_end}%`,
    r.original_deadline && r.original_deadline !== r.deadline ? `${fmtDate(r.deadline)}\n(awal ${fmtDate(r.original_deadline)})` : fmtDate(r.deadline),
    r.latest_note ?? '',
  ])
  autoTable(doc, {
    startY: y, margin: { top: BODY_TOP, left: MARGIN, right: MARGIN, bottom: BODY_BOTTOM }, theme: 'grid',
    head: [['No', 'Tugas / Project', 'Peminta', 'PIC', 'Status', 'Progres', 'Deadline', 'Keterangan / kendala']],
    body, styles: BASE, headStyles: HEAD, alternateRowStyles: ALT, rowPageBreak: 'avoid',
    columnStyles: { 0: { cellWidth: 16.5 }, 1: { cellWidth: 31 }, 2: { cellWidth: 17 }, 3: { cellWidth: 15 }, 4: { cellWidth: 19 }, 5: { cellWidth: 13, halign: 'center' }, 6: { cellWidth: 20 }, 7: { cellWidth: 'auto' } },
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5

  ensure(8)
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(8)
  doc.setTextColor(90, 90, 90)
  doc.text(`Angka mengikuti keadaan di akhir periode (${fmtDate(o.periodEnd)}), bukan keadaan hari ini.`, MARGIN, y)
  doc.setTextColor(0, 0, 0)

  // Kop dan nomor halaman di setiap halaman
  const pages = doc.getNumberOfPages()
  const printed = `Dicetak oleh ${o.author} pada ${wibStamp(o.printedAt)} WIB`
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    drawKop(doc, o.assets)
    drawFooter(doc, printed, p, pages)
  }
  return doc
}
