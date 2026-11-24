// Edge Function: Developer mengatur ulang kata sandi pengguna tanpa email (akun login bukan mailbox sungguhan).
// Deploy : supabase functions deploy set-password          (JWT diverifikasi gateway; role dicek lagi di sini)
// Secret : APP_URL (origin CORS)
// Pemakaian: POST { user_id, password } dengan JWT Developer. Setiap pengaturan dicatat di admin_log (tanpa sandinya).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const MIN_LENGTH = 8
const MAX_LENGTH = 72 // batas bcrypt

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
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers: cors })

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'Gunakan POST' })

  const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

  try {
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const { data: u, error: uErr } = await sb.auth.getUser(jwt)
    if (uErr || !u.user) return reply(401, { error: 'Masuk dulu' })
    const { data: caller } = await sb.from('profiles').select('role, is_active').eq('id', u.user.id).maybeSingle()
    if (!caller?.is_active || caller.role !== 'developer') return reply(403, { error: 'Hanya Developer' })

    let body: { user_id?: unknown; password?: unknown } = {}
    try { body = await req.json() } catch { /* ditolak oleh validasi di bawah */ }
    const userId = typeof body.user_id === 'string' ? body.user_id : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return reply(400, { error: 'Pengguna tidak valid' })
    if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
      return reply(400, { error: `Kata sandi ${MIN_LENGTH}-${MAX_LENGTH} karakter` })
    }

    const { data: target } = await sb.from('profiles').select('id').eq('id', userId).maybeSingle()
    if (!target) return reply(404, { error: 'Pengguna tidak ditemukan' })

    const { error: upErr } = await sb.auth.admin.updateUserById(userId, { password })
    if (upErr) return reply(400, { error: upErr.message })

    const { error: logErr } = await sb.from('admin_log').insert({
      actor_id: u.user.id, target_id: userId, action: 'set_password', details: {},
    })
    if (logErr) console.error(logErr.message) // sandi sudah berubah; log gagal tidak membatalkan
    return reply(200, { ok: true })
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'Kesalahan server' })
  }
})
