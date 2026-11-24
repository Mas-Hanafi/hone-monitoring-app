// Logika hapus foto. Tanpa import supaya bisa dites dengan klien tiruan.
// Dua pekerjaan: (1) foto lewat masa simpan, (2) file yatim di bucket.
// Hapus file dulu, baru tandai deleted_at: kalau tanda gagal, run berikutnya
// menghapus ulang file yang sudah tidak ada (aman, tidak error).

const BUCKET = 'task-photos';
const MAX_ORPHANS = 200; // lebih dari ini = curiga ada yang salah, jangan hapus otomatis

type Err = { message: string } | null;
export interface Sb {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  storage: { from(bucket: string): { remove(paths: string[]): Promise<{ error: Err }> } };
}
export interface Result {
  dryRun: boolean;
  expired: number;
  orphans: number;
  orphansSkipped: boolean;
}

function check(error: Err, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export async function cleanup(
  sb: Sb,
  { dryRun = false, batch = 1000, maxBatches = 5 } = {},
): Promise<Result> {
  const out: Result = { dryRun, expired: 0, orphans: 0, orphansSkipped: false };
  const bucket = sb.storage.from(BUCKET);

  // 1. Foto kedaluwarsa (satu panggilan remove maksimal 1000 objek)
  for (let i = 0; i < maxBatches; i++) {
    const { data, error } = await sb.from('attachments_expired').select('id, storage_path').limit(batch);
    check(error, 'baca attachments_expired');
    if (!data.length) break;
    if (dryRun) { out.expired += data.length; break; } // dry run tidak mengubah apa pun, jangan loop

    const rm = await bucket.remove(data.map((r: { storage_path: string }) => r.storage_path));
    check(rm.error, 'hapus file');
    const up = await sb.from('attachments')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', data.map((r: { id: string }) => r.id));
    check(up.error, 'tandai deleted_at');
    out.expired += data.length;
    if (data.length < batch) break;
  }

  // 2. File yatim (unggah sukses, laporan tidak pernah masuk)
  const { data: orph, error: oe } = await sb.from('storage_orphans').select('storage_path').limit(MAX_ORPHANS + 1);
  check(oe, 'baca storage_orphans');
  if (orph.length > MAX_ORPHANS) {
    out.orphansSkipped = true;
  } else if (orph.length) {
    if (!dryRun) {
      const rm = await bucket.remove(orph.map((r: { storage_path: string }) => r.storage_path));
      check(rm.error, 'hapus file yatim');
    }
    out.orphans = orph.length;
  }
  return out;
}
