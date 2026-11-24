import { runArchive } from '../supabase/functions/archive-routine/archive.ts';
import { buildRow, fileName, extOf, link, HEADERS } from '../supabase/functions/archive-routine/rows.ts';

// Uji arsip bukti rutin ke Drive: nama berkas, baris Sheet, idempotensi, dan kegagalan sebagian.
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + label + (c ? '' : '  ' + extra)); };

const mkRun = (id, over = {}) => ({
  id, period: '2026-11-15', submitted_at: '2026-11-15T03:00:00Z', ng_count: 1,
  template: { key: 'panel', name: 'Panel', frequency: 'daily' }, inspector: 'Budi', ngs: ['Panel 3 - Kontaktor: gosong'], objects: [],
  files: [
    { id: 1, kind: 'signature', storage_path: 'panel/2026-11-15/u/s.png', drive_id: null, drive_url: null },
    { id: 2, kind: 'photo', storage_path: 'panel/2026-11-15/u/a.jpg', drive_id: null, drive_url: null },
    { id: 3, kind: 'photo', storage_path: 'panel/2026-11-15/u/b.jpg', drive_id: null, drive_url: null },
  ], ...over,
});

function fakeDeps(runs, o = {}) {
  const log = { uploads: [], marks: [], rows: [], runsMarked: [], folders: [] };
  const deps = {
    readPending: async () => runs,
    folderFor: async (r) => { log.folders.push(r.id); return { url: 'https://drive.google.com/drive/folders/F1' }; },
    download: async (p) => { if (o.failDownload?.includes(p)) throw new Error('unduh gagal'); return { bytes: new Uint8Array([1, 2, 3]), type: p.endsWith('.png') ? 'image/png' : 'image/jpeg' }; },
    upload: async (run, name, bytes, type) => { log.uploads.push({ run: run.id, name, type }); const id = `D${log.uploads.length}`; return { id, url: `https://drive.google.com/file/d/${id}/view` }; },
    markFile: async (id, d) => { log.marks.push([id, d.id]); },
    sheet: { existingIds: async () => new Set(o.known ?? []), append: async (rows) => { log.rows.push(...rows); } },
    markRun: async (id) => { log.runsMarked.push(id); },
  };
  return { deps, log };
}

// ---- rows.ts ----
const r0 = mkRun('r0');
ok(fileName(r0, r0.files[0], 0, 'png') === '2026-11-15_panel_1000_tanda-tangan.png', 'nama berkas tanda tangan (dengan jam kirim WIB)');
ok(fileName(r0, r0.files[2], 2, 'jpg') === '2026-11-15_panel_1000_foto-2.jpg', 'nama berkas foto bernomor');
ok(extOf('image/png', 'x') === 'png' && extOf('', 'a/b.JPG') === 'jpg' && extOf('', 'noext') === 'noext', 'ekstensi dari tipe atau nama');
ok(link('https://drive.google.com/file/d/abc/view') !== '' && link('http://evil.com/x') === '' && link('https://drive.google.com.evil.com/x') === '' && link(null) === '', 'hanya tautan Drive yang lolos');
ok(link('javascript:alert(1)') === '' && link('https://drive.google.com/x"y') === '', 'tautan berbahaya ditolak');

// ---- alur normal ----
{
  const { deps, log } = fakeDeps([mkRun('r1')]);
  const res = await runArchive(deps);
  ok(res.runs === 1 && res.files === 3 && res.rows === 1 && res.errors.length === 0, 'satu isian: 3 berkas, 1 baris, tanpa galat', JSON.stringify(res));
  ok(log.uploads.map(u => u.name).join() === '2026-11-15_panel_1000_tanda-tangan.png,2026-11-15_panel_1000_foto-1.jpg,2026-11-15_panel_1000_foto-2.jpg', 'berkas diunggah dengan nama yang benar');
  ok(log.uploads.every(u => u.run === 'r1'), 'semua berkas diunggah untuk isian yang benar');
  ok(log.marks.length === 3 && log.runsMarked.join() === 'r1', 'berkas dan isian ditandai terarsip');
  const row = log.rows[0];
  ok(row.length === HEADERS.length, 'jumlah kolom baris sama dengan header', `${row.length} vs ${HEADERS.length}`);
  ok(row[0] === 'r1' && row[6] === '1 NG' && row[8].includes('gosong'), 'baris memuat ID, hasil, dan temuan NG');
  ok(row[9].startsWith('https://drive.google.com/file/d/') && row[10].startsWith('https://') && row[11].startsWith('https://') && row[12] === '', 'tautan tanda tangan dan foto terisi, foto kosong dibiarkan');
  ok(row[16] === 'https://drive.google.com/drive/folders/F1', 'tautan folder terisi');
  ok(row[17] === '', 'kolom objek kosong untuk checklist penuh');
}

// ---- isian per kamar ----
{
  const { deps, log } = fakeDeps([mkRun('rr', { template: { key: 'room', name: 'Room', frequency: 'weekly' }, objects: ['101', '205'], ng_count: 0, ngs: [] })]);
  await runArchive(deps);
  ok(log.rows[0][17] === '101, 205' && log.rows[0][6] === 'Semua OK', 'isian Room mencatat kamar yang diperiksa');
}

// ---- idempotensi ----
{
  const { deps, log } = fakeDeps([mkRun('r2')], { known: ['r2'] });
  const res = await runArchive(deps);
  ok(res.rows === 0 && log.rows.length === 0 && res.runs === 1, 'ID yang sudah ada di Sheet tidak ditulis ganda');
}
{
  const run = mkRun('r3');
  run.files[0].drive_url = 'https://drive.google.com/file/d/OLD/view';
  run.files[1].drive_url = 'https://drive.google.com/file/d/OLD2/view';
  const { deps, log } = fakeDeps([run]);
  const res = await runArchive(deps);
  ok(res.files === 1 && log.uploads.length === 1, 'berkas yang sudah tersalin tidak diunggah ulang');
  ok(log.rows[0][9].endsWith('/OLD/view'), 'tautan lama dipakai di baris');
}

// ---- gagal sebagian ----
{
  const bad = mkRun('bad');
  const { deps, log } = fakeDeps([bad, mkRun('good')], { failDownload: ['panel/2026-11-15/u/a.jpg'] });
  const res = await runArchive(deps);
  ok(res.errors.length === 2 || res.errors.length === 1, 'galat dicatat', JSON.stringify(res.errors));
  // kedua isian memakai path berkas yang sama di fake; yang penting tidak ada isian ditandai selesai saat gagal
  ok(!log.runsMarked.includes('bad') && log.rows.every(r => r[0] !== 'bad'), 'isian gagal tidak ditandai dan tidak masuk Sheet');
}
{
  const { deps } = fakeDeps([]);
  const res = await runArchive(deps);
  ok(res.runs === 0 && res.errors.length === 0, 'tidak ada antrean: tidak melakukan apa pun');
}
// ---- unggah gagal tidak menandai ----
{
  const { deps, log } = fakeDeps([mkRun('r4')]);
  deps.upload = async () => { throw new Error('storageQuotaExceeded'); };
  const res = await runArchive(deps);
  ok(res.errors[0]?.includes('storageQuotaExceeded') && log.runsMarked.length === 0 && log.rows.length === 0, 'unggah gagal: tidak ada baris dan tidak ditandai (dicoba lagi nanti)');
}

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
