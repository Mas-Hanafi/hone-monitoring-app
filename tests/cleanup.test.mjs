const { cleanup } = await import(new URL('../supabase/functions/cleanup-photos/cleanup.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + x)); };

function mock({ expired = [], orphans = [], removeErr = null, updateErr = null } = {}) {
  const calls = { removed: [], updated: [] };
  let exp = [...expired];
  const sb = {
    from(t) {
      return {
        select: () => ({ limit: async (n) => ({
          data: t === 'attachments_expired' ? exp.slice(0, n) : orphans.slice(0, n), error: null }) }),
        update: (v) => ({ in: async (_c, ids) => {
          if (updateErr) return { error: { message: updateErr } };
          calls.updated.push(...ids); exp = exp.filter(r => !ids.includes(r.id)); return { error: null }; } }),
      };
    },
    storage: { from: () => ({ remove: async (p) => removeErr ? { error: { message: removeErr } } : (calls.removed.push(...p), { error: null }) }) },
  };
  return { sb, calls };
}
const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, storage_path: `t/${p}${i}.jpg` }));

let m = mock({ expired: mk(3, 'e'), orphans: mk(2, 'o') });
let r = await cleanup(m.sb);
ok(r.expired === 3 && r.orphans === 2 && m.calls.removed.length === 5 && m.calls.updated.length === 3, 'hapus 3 kedaluwarsa + 2 yatim, tandai deleted_at', JSON.stringify([r, m.calls]));

m = mock({ expired: mk(3, 'e'), orphans: mk(2, 'o') });
r = await cleanup(m.sb, { dryRun: true });
ok(r.dryRun && r.expired === 3 && r.orphans === 2 && m.calls.removed.length === 0 && m.calls.updated.length === 0, 'dry run tidak menghapus apa pun');

m = mock({ expired: mk(5, 'e') });
r = await cleanup(m.sb, { batch: 2, maxBatches: 10 });
ok(r.expired === 5 && m.calls.removed.length === 5, 'beberapa batch (2+2+1)');

m = mock({ expired: mk(10, 'e') });
r = await cleanup(m.sb, { batch: 2, maxBatches: 2 });
ok(r.expired === 4, 'berhenti di maxBatches', String(r.expired));

m = mock({ orphans: mk(201, 'o') });
r = await cleanup(m.sb);
ok(r.orphansSkipped && r.orphans === 0 && m.calls.removed.length === 0, 'yatim > 200 tidak dihapus (pengaman)');

m = mock({ expired: mk(2, 'e'), removeErr: 'boom' });
let e = await cleanup(m.sb).catch(x => x.message);
ok(String(e).includes('hapus file') && m.calls.updated.length === 0, 'gagal hapus file => tidak ditandai deleted_at');

m = mock({ expired: mk(2, 'e'), updateErr: 'db down' });
e = await cleanup(m.sb).catch(x => x.message);
ok(String(e).includes('tandai deleted_at') && m.calls.removed.length === 2, 'gagal tandai => error, file sudah terhapus (run berikutnya aman)');

m = mock();
r = await cleanup(m.sb);
ok(r.expired === 0 && r.orphans === 0 && !r.orphansSkipped, 'kosong => tidak ada kerja');
console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
