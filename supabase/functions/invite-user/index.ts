// Edge Function: Developer mengundang pengguna baru (email undangan + profil).
// Deploy : supabase functions deploy invite-user          (JWT diverifikasi gateway; role dicek lagi di sini)
// Secret : supabase secrets set APP_URL=https://<alamat-app>   (tujuan tautan undangan + origin CORS)
// Dengan "password" di body: akun dibuat langsung tanpa email (dipakai app ini, tanpa SMTP).
// Tanpa "password": undangan lewat email Supabase (butuh SMTP sendiri; SMTP bawaan sangat dibatasi per jam).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { inviteUser, type Deps } from './invite.ts'

function need(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`${name} belum diisi`)
  return v
}

Deno.serve(async (req) => {
  let appUrl: string
  try { appUrl = need('APP_URL') } catch (e) {
    return new Response(String((e as Error).message), { status: 500 })
  }
  const cors = {
    'access-control-allow-origin': new URL(appUrl).origin,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  }
  const reply = (status: number, body: unknown) =>
    Response.json(body, { status, headers: cors })

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'Gunakan POST' })

  const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  })

  const deps: Deps = {
    async callerFromJwt(jwt) {
      const { data, error } = await sb.auth.getUser(jwt)
      if (error || !data.user) return null
      const { data: p } = await sb.from('profiles').select('id, role, is_active').eq('id', data.user.id).maybeSingle()
      return p
    },
    async departmentExists(id) {
      const { data } = await sb.from('departments').select('id').eq('id', id).eq('is_active', true).maybeSingle()
      return !!data
    },
    async inviteByEmail(email, password) {
      // Dengan sandi: akun langsung aktif tanpa email (email login bukan mailbox sungguhan)
      const { data, error } = password
        ? await sb.auth.admin.createUser({ email, password, email_confirm: true })
        : await sb.auth.admin.inviteUserByEmail(email, { redirectTo: appUrl })
      if (error) {
        const exists = error.code === 'email_exists' || /already/i.test(error.message)
        return { error: exists ? 'exists' : error.message }
      }
      return { id: data.user.id }
    },
    async insertProfile(p) {
      const { error } = await sb.from('profiles').insert(p)
      return error?.message ?? null
    },
    async log(actorId, targetId, details) {
      const { error } = await sb.from('admin_log').insert({
        actor_id: actorId, target_id: targetId, action: 'invite_user', details,
      })
      return error?.message ?? null
    },
    async rollback(userId) {
      await sb.from('profiles').delete().eq('id', userId)
      await sb.auth.admin.deleteUser(userId)
    },
  }

  let body: unknown = null
  try { body = await req.json() } catch { /* body kosong => validasi menolak */ }
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null

  try {
    const out = await inviteUser(deps, jwt, body)
    if (out.status >= 500) console.error(out.body)
    return reply(out.status, out.body)
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'Kesalahan server' })
  }
})
