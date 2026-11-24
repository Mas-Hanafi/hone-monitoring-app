const { inviteUser, validate } = await import(new URL('../supabase/functions/invite-user/invite.ts', import.meta.url).href);
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + l + (c ? '' : ' ' + JSON.stringify(x))); };

const good = { email: '  Ani@Contoh.COM ', full_name: ' Ani ', role: 'staff', department_id: 3 };
function deps(o = {}) {
  const calls = [];
  const d = {
    callerFromJwt: async (j) => (j === 'bad' ? null : o.caller ?? { id: 'dev1', role: 'developer', is_active: true }),
    departmentExists: async (id) => { calls.push('dept'); return o.deptOk ?? true; },
    inviteByEmail: async (e, pw) => { calls.push('invite:' + e + (pw ? ':pw' : '')); return o.invite ?? { id: 'u1' }; },
    insertProfile: async (p) => { calls.push('profile:' + JSON.stringify(p)); return o.profileErr ?? null; },
    log: async () => { calls.push('log'); return o.logErr ?? null; },
    rollback: async (id) => { calls.push('rollback:' + id); },
  };
  return { d, calls };
}

// validasi
ok(validate(good).ok && validate(good).value.email === 'ani@contoh.com' && validate(good).value.full_name === 'Ani', 'email di-trim + huruf kecil, nama di-trim');
for (const [label, patch] of [
  ['email kosong', { email: '' }], ['email tanpa @', { email: 'abc' }], ['nama kosong', { full_name: '  ' }],
  ['nama > 100', { full_name: 'x'.repeat(101) }], ['role asing', { role: 'owner' }], ['departemen bukan integer', { department_id: '3' }],
]) ok(!validate({ ...good, ...patch }).ok, 'tolak: ' + label);
ok(!('weekly_capacity_hours' in validate(good).value), 'tidak ada lagi kapasitas di hasil validasi');
ok(!validate(null).ok && !validate('x').ok, 'body bukan objek ditolak');

// otorisasi
let t = deps();
ok((await inviteUser(t.d, null, good)).status === 401, 'tanpa token => 401');
ok((await inviteUser(t.d, 'bad', good)).status === 401 && t.calls.length === 0, 'token tidak valid => 401, tidak ada efek samping');
for (const role of ['staff', 'supervisor', 'manager']) {
  t = deps({ caller: { id: 'x', role, is_active: true } });
  ok((await inviteUser(t.d, 'ok', good)).status === 403 && t.calls.length === 0, `${role} => 403, tidak mengundang`);
}
t = deps({ caller: { id: 'x', role: 'developer', is_active: false } });
ok((await inviteUser(t.d, 'ok', good)).status === 403, 'Developer nonaktif => 403');

// alur
t = deps();
let r = await inviteUser(t.d, 'ok', good);
ok(r.status === 200 && r.body.id === 'u1' && t.calls[1] === 'invite:ani@contoh.com' && t.calls.at(-1) === 'log', 'sukses: undang -> profil -> log', t.calls);
ok(JSON.parse(t.calls[2].slice(8)).role === 'staff' && !t.calls[2].includes('email'), 'profil tidak membawa email, membawa role');
t = deps({ deptOk: false });
r = await inviteUser(t.d, 'ok', good);
ok(r.status === 400 && !t.calls.some(c => c.startsWith('invite')), 'departemen tidak ada => 400, belum mengundang');
t = deps({ invite: { error: 'exists' } });
ok((await inviteUser(t.d, 'ok', good)).status === 409, 'email sudah terdaftar => 409');
t = deps({ invite: { error: 'rate limit' } });
ok((await inviteUser(t.d, 'ok', good)).status === 502, 'gagal kirim email => 502');
t = deps({ profileErr: 'duplicate key' });
r = await inviteUser(t.d, 'ok', good);
ok(r.status === 500 && t.calls.includes('rollback:u1') && !t.calls.includes('log'), 'gagal buat profil => rollback akun Auth');
t = deps({ logErr: 'down' });
r = await inviteUser(t.d, 'ok', good);
ok(r.status === 500 && t.calls.includes('rollback:u1'), 'gagal catat log => rollback (tidak ada akun tanpa jejak)');

// akun langsung dibuat dengan sandi (tanpa email)
for (const [label, pw] of [['sandi 7 karakter', 'abcdefg'], ['sandi 73 karakter', 'x'.repeat(73)], ['sandi bukan string', 12345678]])
  ok(!validate({ ...good, password: pw }).ok, 'tolak: ' + label);
ok(validate({ ...good, password: 'abcdefgh' }).ok && validate({ ...good, password: null }).value.password === null, 'sandi 8 karakter diterima; kosong => undangan email');
t = deps();
r = await inviteUser(t.d, 'ok', { ...good, password: 'Sandi-Awal1' });
ok(r.status === 200 && t.calls[1] === 'invite:ani@contoh.com:pw', 'dengan sandi: dikirim ke pembuat akun');
ok(!t.calls.some(c => c.includes('Sandi-Awal1')), 'sandi tidak masuk profil maupun log');

console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
