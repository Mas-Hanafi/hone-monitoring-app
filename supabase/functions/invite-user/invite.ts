// Logika undangan pengguna. Tanpa import, dependensi disuntik, supaya mudah dites.
// Urutan: cek pemanggil -> validasi -> undang (Auth) -> buat profil -> catat log.
// Gagal di langkah mana pun setelah undangan => rollback (hapus profil + akun Auth),
// supaya tidak ada akun yatim yang bisa login tanpa profil.

export const ROLES = ['staff', 'supervisor', 'manager', 'developer'] as const

export interface InviteInput {
  email: string
  full_name: string
  role: (typeof ROLES)[number]
  department_id: number
  password: string | null // diisi => akun langsung dibuat tanpa email; kosong => undangan lewat email
}

export interface Caller { id: string; role: string; is_active: boolean }

export interface Deps {
  callerFromJwt(jwt: string): Promise<Caller | null>
  departmentExists(id: number): Promise<boolean>
  inviteByEmail(email: string, password: string | null): Promise<{ id: string } | { error: 'exists' | string }>
  insertProfile(p: { id: string } & Omit<InviteInput, 'email' | 'password'>): Promise<string | null> // pesan error atau null
  log(actorId: string, targetId: string, details: Record<string, unknown>): Promise<string | null>
  rollback(userId: string): Promise<void>
}

export interface Outcome { status: number; body: Record<string, unknown> }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validate(raw: unknown): { ok: true; value: InviteInput } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const name = typeof b.full_name === 'string' ? b.full_name.trim() : ''
  if (!email || email.length > 254 || !EMAIL.test(email)) return { ok: false, error: 'Email tidak valid' }
  if (!name || name.length > 100) return { ok: false, error: 'Nama wajib diisi (maks 100 karakter)' }
  if (!ROLES.includes(b.role as never)) return { ok: false, error: 'Role tidak valid' }
  if (!Number.isInteger(b.department_id)) return { ok: false, error: 'Departemen tidak valid' }
  const pw = b.password
  if (pw != null && (typeof pw !== 'string' || pw.length < 8 || pw.length > 72)) {
    return { ok: false, error: 'Kata sandi 8 sampai 72 karakter' }
  }
  return {
    ok: true,
    value: {
      email, full_name: name, role: b.role as InviteInput['role'],
      department_id: b.department_id as number,
      password: (pw as string | null | undefined) ?? null,
    },
  }
}

export async function inviteUser(deps: Deps, jwt: string | null, raw: unknown): Promise<Outcome> {
  if (!jwt) return { status: 401, body: { error: 'Belum login' } }
  const caller = await deps.callerFromJwt(jwt)
  if (!caller) return { status: 401, body: { error: 'Sesi tidak valid' } }
  if (caller.role !== 'developer' || !caller.is_active) {
    return { status: 403, body: { error: 'Hanya Developer yang dapat mengundang pengguna' } }
  }

  const v = validate(raw)
  if (!v.ok) return { status: 400, body: { error: v.error } }
  const input = v.value
  if (!(await deps.departmentExists(input.department_id))) {
    return { status: 400, body: { error: 'Departemen tidak ditemukan' } }
  }

  const invited = await deps.inviteByEmail(input.email, input.password)
  if ('error' in invited) {
    return invited.error === 'exists'
      ? { status: 409, body: { error: 'Email sudah terdaftar' } }
      : { status: 502, body: { error: `Gagal mengirim undangan: ${invited.error}` } }
  }

  const { email: _email, password: _password, ...profile } = input
  const insertError = await deps.insertProfile({ id: invited.id, ...profile })
  if (insertError) {
    await deps.rollback(invited.id)
    return { status: 500, body: { error: `Gagal membuat profil: ${insertError}` } }
  }
  const logError = await deps.log(caller.id, invited.id, {
    email: input.email, role: input.role, department_id: input.department_id,
  })
  if (logError) {
    await deps.rollback(invited.id)
    return { status: 500, body: { error: `Gagal mencatat log: ${logError}` } }
  }
  return { status: 200, body: { id: invited.id, email: input.email } }
}
