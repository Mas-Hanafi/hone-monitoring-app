const { summarize } = await import(new URL('../src/lib/stats.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };
const today = '2026-11-08', now = Date.parse('2026-11-08T05:00:00Z'), ago = d => new Date(now - d * 86400000).toISOString();
const T = (o) => ({ id: Math.random().toString(36), title: 't', status: 'in_progress', progress: 0, is_urgent: false, deadline: '2026-11-20',
  last_update_at: ago(0), pic_name: 'Ani', ...o });

const tasks = [
  T({ deadline: '2026-11-05' }),                                  // terlambat 3 hari
  T({ last_update_at: ago(5), is_urgent: true }),                 // macet 5 hari
  T({ status: 'on_hold', last_update_at: ago(20) }),              // hold tidak dianggap macet
  T({ pic_name: 'Budi', deadline: '2026-11-10' }),
  T({ pic_name: 'Budi', deadline: '2026-11-30' }),
  T({ pic_name: 'Cici', deadline: '2026-11-07' }),                // terlambat 1 hari
  T({ status: 'done' }),                                          // diabaikan
];
const s = summarize(tasks, today, now);
ok(s.kpi.active === 6 && s.kpi.urgent === 1 && s.kpi.late === 2 && s.kpi.stale === 1, 'KPI aktif/urgent/terlambat/macet', s.kpi);
ok(s.attention.length === 3 && s.attention[0].reasons[0] === 'Terlambat 3 hari', 'perlu perhatian: terlambat 3 hari paling atas', s.attention);
ok(s.attention.every((a) => a.pic && !('dept' in a)), 'baris perhatian membawa nama PIC, tanpa departemen');
ok(!s.attention.some(a => a.reasons.some(r => r.startsWith('Macet 20'))), 'hold tidak masuk daftar macet');
ok(!('people' in s) && !('depts' in s), 'tidak ada lagi beban per orang / per departemen');
const none = summarize([], today, now);
ok(none.kpi.active === 0 && none.attention.length === 0, 'kosong aman');
console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
