const csv = await import(new URL('../src/lib/csv.ts', import.meta.url).href);
const rep = await import(new URL('../src/lib/report.ts', import.meta.url).href);
const dt = await import(new URL('../src/lib/date.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };

// CSV
ok(csv.csvCell(null) === '' && csv.csvCell(undefined) === '' && csv.csvCell(NaN) === '', 'null/undefined/NaN => kosong');
ok(csv.csvCell(70) === '70' && csv.csvCell(-5) === '-5' && csv.csvCell(2.5) === '2.5', 'angka apa adanya (termasuk negatif)');
ok(csv.csvCell('a;b') === '"a;b"' && csv.csvCell('a,b') === 'a,b', 'pemisah ; di-quote, koma tidak');
ok(csv.csvCell('dia bilang "ya"') === '"dia bilang ""ya"""', 'tanda kutip di-escape');
ok(csv.csvCell('baris1\nbaris2') === '"baris1\nbaris2"', 'baris baru di-quote');
for (const bad of ['=1+1', '+62812', '-2+3', '@SUM(A1)', '=HYPERLINK("http://x","y")']) ok(csv.csvCell(bad).replace(/^"/, '').startsWith("'"), 'guard rumus: ' + bad);
ok(csv.csvCell('2026-11-08') === '2026-11-08' && csv.csvCell('Cat lobi') === 'Cat lobi', 'teks biasa dan tanggal tidak diubah');
ok(csv.toCsv(['A', 'B'], [[1, 'x;y'], [null, 'z']]) === 'A;B\r\n1;"x;y"\r\n;z\r\n', 'toCsv: header, quoting, CRLF');

// laporan
const row = (o) => ({ task_no: 1, title: 'T', requester: 'FO', pic: 'Ani', pic_department: 'HK', status: 'in_progress', approval: 'Pending', urgency: 'Normal',
  progress_start: 10, progress_end: 40, original_deadline: '2026-11-05', deadline: '2026-11-05', assigned_on: '2026-11-01', started_on: null,
  completed_on: null, closed_on: null, last_update_on: '2026-11-07', latest_note: null, ...o });
const rows = [
  row({ task_no: 1 }),                                                              // aktif, terlambat (deadline < 8 Nov)
  row({ task_no: 2, status: 'done', progress_end: 100, deadline: '2026-11-01', urgency: 'Urgent' }), // selesai
  row({ task_no: 3, status: 'cancelled', pic: 'Budi', pic_department: 'IT' }),
  row({ task_no: 4, pic: 'Budi', pic_department: 'IT', deadline: '2026-11-08', progress_end: 20 }), // aktif, deadline = akhir periode => belum terlambat
];
const L = { in_progress: 'Dikerjakan', done: 'Selesai', cancelled: 'Dibatalkan' };
const t = rep.rowsToTable(rows, L);
ok(t.headers.length === 18 && t.body[0].length === 18 && t.body[1][5] === 'Selesai', 'tabel rincian: 18 kolom, status berbahasa Indonesia');
ok(t.body[0][8] === 10 && t.body[0][9] === 40, 'progress awal dan akhir sebagai angka');
const c = rep.countRows(rows, '2026-11-08');
ok(c.total === 4 && c.finished === 1 && c.active === 2 && c.cancelled === 1 && c.urgent === 1 && c.late === 1, 'hitungan: total/selesai/aktif/batal/urgent/terlambat', c);
const rc = rep.buildRecap(rows, '2026-11-08');
ok(rc.body.length === 2 && rc.body[0][0] === 'Ani' && rc.body[0][2] === 2 && rc.body[0][3] === 1 && rc.body[0][7] === 1 && rc.body[0][8] === 70, 'rekap Ani: 2 tugas, 1 selesai, 1 terlambat, rata-rata 70%', rc.body[0]);
ok(rc.body[1][0] === 'Budi' && rc.body[1][5] === 1 && rc.body[1][7] === 0, 'rekap Budi: 1 dibatalkan, 0 terlambat', rc.body[1]);
ok(rep.buildRecap([], '2026-11-08').body.length === 0, 'rekap kosong aman');

// periode
const w = (d) => JSON.stringify(dt.weekRange(d));
ok(w('2026-11-08') === '{"start":"2026-11-02","end":"2026-11-08"}', 'Minggu 8 Nov => minggu 2-8 Nov', w('2026-11-08'));
ok(w('2026-11-09') === '{"start":"2026-11-09","end":"2026-11-15"}', 'Senin 9 Nov => minggu 9-15 Nov');
ok(w('2026-12-31') === '{"start":"2026-12-28","end":"2027-01-03"}', 'minggu lintas tahun');
ok(dt.monthRange('2026-11').end === '2026-11-30' && dt.monthRange('2026-12').end === '2026-12-31', 'akhir bulan 30/31 hari');
ok(dt.monthRange('2028-02').end === '2028-02-29' && dt.monthRange('2027-02').end === '2027-02-28', 'Februari kabisat dan biasa');
ok(dt.prevMonth('2026-01-15') === '2025-12' && dt.prevMonth('2026-11-08') === '2026-10', 'bulan sebelumnya (lintas tahun)');
ok(dt.addDaysStr('2026-11-02', -7) === '2026-10-26', 'addDaysStr mundur');

console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
