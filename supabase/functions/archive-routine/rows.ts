// Fungsi murni untuk arsip rutin: nama berkas dan baris spreadsheet. Dipisah supaya bisa diuji tanpa jaringan.

export const TAB = 'Rutin'
export const HEADERS = [
  'ID isian', 'Periode', 'Checklist', 'Frekuensi', 'Pengisi', 'Dikirim (WIB)', 'Hasil', 'Jumlah NG', 'Temuan NG',
  'Tanda tangan', 'Foto 1', 'Foto 2', 'Foto 3', 'Foto 4', 'Foto 5', 'Foto 6', 'Folder Drive', 'Objek diperiksa',
]

export interface FileRecord { id: number; kind: 'photo' | 'signature'; storage_path: string; drive_id: string | null; drive_url: string | null }
export interface RunRecord {
  id: string
  period: string            // YYYY-MM-DD (harian: tanggalnya; mingguan: hari Senin)
  submitted_at: string
  ng_count: number
  template: { key: string; name: string; frequency: 'daily' | 'weekly' }
  inspector: string
  ngs: string[]             // "Panel 3 - Kontaktor...: catatan"
  objects: string[]          // kamar/objek yang diperiksa pada isian ini (kosong untuk checklist penuh)
  files: FileRecord[]
}

// Sheet ditulis dengan RAW (nilai apa adanya, tidak pernah dijalankan sebagai rumus), jadi teks pengguna aman.
// Tautan Drive berupa teks biasa; Sheets menampilkannya sebagai tautan yang bisa diklik.
export const safe = (s: string): string => s

// Hanya tautan Drive resmi yang boleh masuk ke Sheet
export function link(url: string | null | undefined): string {
  return url && /^https:\/\/drive\.google\.com\/[A-Za-z0-9_\-/.?=&%]+$/.test(url) ? url : ''
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
export const extOf = (type: string, path: string): string =>
  EXT[type] ?? (path.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin')

// Jam kirim WIB (HHmm): membedakan beberapa isian pada periode yang sama (Room dikirim per kamar)
export const hhmm = (iso: string): string =>
  new Date(iso).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\D/g, '')

export function fileName(run: RunRecord, f: FileRecord, nth: number, ext: string): string {
  const base = `${run.period}_${run.template.key}_${hhmm(run.submitted_at)}`
  return f.kind === 'signature' ? `${base}_tanda-tangan.${ext}` : `${base}_foto-${nth}.${ext}`
}

export const wib = (iso: string): string =>
  new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })

// Satu baris per isian: ringkasan + tautan ke tanda tangan dan foto di Drive
export function buildRow(run: RunRecord, folderUrl: string): string[] {
  const sig = run.files.find((f) => f.kind === 'signature')
  const photos = run.files.filter((f) => f.kind === 'photo')
  return [
    run.id,
    run.period,
    safe(run.template.name),
    run.template.frequency === 'weekly' ? 'Mingguan' : 'Harian',
    safe(run.inspector),
    wib(run.submitted_at),
    run.ng_count ? `${run.ng_count} NG` : 'Semua OK',
    String(run.ng_count),
    safe(run.ngs.join(' | ').slice(0, 1500)),
    link(sig?.drive_url),
    ...Array.from({ length: 6 }, (_, i) => link(photos[i]?.drive_url)),
    link(folderUrl),
    safe(run.objects.join(', ').slice(0, 1500)),
  ]
}
