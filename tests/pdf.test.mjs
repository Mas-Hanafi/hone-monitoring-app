import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Uji laporan PDF: kop surat dari template, isi tabel, banyak halaman, nomor halaman, tautan email.
const { buildReportPdf, fmtDate, BODY_TOP } = await import(new URL('../src/lib/pdfReport.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };

const uri = (f) => 'data:image/png;base64,' + readFileSync(new URL(`../src/assets/kop/${f}`, import.meta.url)).toString('base64');
const assets = { logo: uri('logo.png'), line: uri('line.png') };
const STATUS = { not_started: 'Belum dimulai', in_progress: 'Dikerjakan', on_hold: 'Hold', done: 'Selesai', handover: 'Handover', cancelled: 'Dibatalkan' };

const mk = (n, o = {}) => ({
  task_no: n, title: `Tugas contoh nomor ${n}`, requester: n % 2 ? 'Resort' : 'Operasional', pic: n % 3 ? 'Budi' : 'Cici', pic_department: 'ME',
  status: 'in_progress', approval: 'Pending', urgency: 'Normal', progress_start: 10, progress_end: 60,
  original_deadline: '2026-12-05', deadline: '2026-12-05', assigned_on: '2026-11-01', started_on: '2026-11-02', completed_on: null,
  closed_on: null, last_update_on: '2026-11-10', latest_note: null, ...o,
});
const base = { title: 'LAPORAN TUGAS TIM ME', subtitle: 'Periode 1 Nov 2026 s/d 30 Nov 2026', periodEnd: '2026-11-30', statusLabel: STATUS, author: 'Admin', printedAt: new Date('2026-11-17T04:00:00Z'), assets };

// bantu: ambil teks mentah dari PDF (jsPDF tanpa kompresi menyimpan teks apa adanya)
// (baris yang dibungkus tabel digabung kembali; tanda kurung di dalam teks PDF di-escape dengan garis miring)
const raw = async (doc) => Buffer.from(doc.output('arraybuffer')).toString('latin1').replace(/\) Tj\s+T\* \(/g, ' ').replace(/\\([()])/g, '$1');

// ---- format tanggal ----
ok(fmtDate('2026-12-05') === '5 Des 2026' && fmtDate('2026-01-31') === '31 Jan 2026' && fmtDate(null) === '-', 'tanggal Indonesia');

// ---- dokumen kecil ----
const small = [mk(1), mk(2, { urgency: 'Urgent', status: 'done', approval: 'Approve', completed_on: '2026-11-20', progress_end: 100 }), mk(3, { deadline: '2026-12-20', latest_note: 'Menunggu material dari supplier' })];
const d1 = await buildReportPdf({ ...base, rows: small });
const t1 = await raw(d1);
ok(t1.startsWith('%PDF-'), 'hasilnya berkas PDF');
ok(d1.getNumberOfPages() === 1, 'data sedikit = satu halaman', d1.getNumberOfPages());
const pageSize = d1.internal.pageSize;
ok(Math.round(pageSize.getWidth()) === 210 && Math.round(pageSize.getHeight()) === 297, 'ukuran A4 tegak seperti template');
for (const s of ['H ONE', '(HOSPITALITY)', 'Alamat: Jalan Contoh', 'Kota Contoh', 'hello@hone.example', '0800-0000-0000']) ok(t1.includes(s), `kop memuat: ${s}`);
ok(t1.includes('mailto:hello@hone.example'), 'email pada kop berupa tautan mailto');
ok((t1.match(/\/Subtype \/Image/g) ?? []).length >= 2, 'logo dan garis kop tertanam sebagai gambar');
for (const s of ['LAPORAN TUGAS TIM ME', 'Periode 1 Nov 2026 s/d 30 Nov 2026', 'Rekap per PIC', 'Rincian tugas', 'TSK-0002', '[URGENT]', '20 Nov 2026', 'Approval: Approve', '20 Des 2026', 'Menunggu material dari supplier', 'Halaman 1 dari 1', 'Dicetak oleh Admin']) ok(t1.includes(s), `isi memuat: ${s}`);
ok(t1.includes('(awal 5 Des 2026)'), 'deadline yang diubah menampilkan deadline awal');

// ---- banyak data: beberapa halaman, kop dan nomor di tiap halaman ----
const many = Array.from({ length: 70 }, (_, i) => mk(i + 1, { title: `Pemasangan dan penyesuaian perangkat nomor ${i + 1} di area resort bagian timur`, latest_note: i % 4 === 0 ? 'Menunggu persetujuan anggaran dari bagian keuangan sebelum pembelian material' : null, status: ['done', 'in_progress', 'not_started', 'cancelled'][i % 4], urgency: i % 9 === 0 ? 'Urgent' : 'Normal' }));
const d2 = await buildReportPdf({ ...base, rows: many });
const pages = d2.getNumberOfPages();
ok(pages >= 3, 'banyak tugas = beberapa halaman', pages);
const t2 = await raw(d2);
ok((t2.match(/H ONE/g) ?? []).length === pages, 'kop tampil di setiap halaman');
ok(t2.includes(`Halaman ${pages} dari ${pages}`) && t2.includes(`Halaman 2 dari ${pages}`), 'nomor halaman benar');
ok((t2.match(/TSK-\d{4}/g) ?? []).length >= 70, 'semua 70 tugas tercetak', (t2.match(/TSK-\d{4}/g) ?? []).length);
ok(BODY_TOP > 50 && BODY_TOP < 70, 'isi dimulai di bawah kop');

// ---- keluaran untuk pemeriksaan visual (opsional) ----
if (process.env.PDF_OUT) {
  writeFileSync(join(process.env.PDF_OUT, 'kecil.pdf'), Buffer.from(d1.output('arraybuffer')));
  writeFileSync(join(process.env.PDF_OUT, 'banyak.pdf'), Buffer.from(d2.output('arraybuffer')));
}
void mkdtempSync; void tmpdir;
console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
