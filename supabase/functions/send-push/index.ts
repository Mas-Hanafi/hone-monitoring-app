// Edge Function terjadwal: kirim push HP untuk notifikasi yang belum didorong (pushed_at kosong).
// Deploy : supabase functions deploy send-push --no-verify-jwt
// Secret : CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:alamat@email-kamu)
//          Buat kunci: npx web-push generate-vapid-keys
// Uji    : POST ...?dry_run=1 dengan header x-cron-secret (hanya menghitung yang menunggu)
// Dipicu pg_cron tiap menit lewat supabase/cron.sql.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import webpush from 'npm:web-push@3.6.7'
import { deliver, type Deps, type Notif, type Sub } from './push.ts'

function need(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`${name} belum diisi`)
  return v
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('unauthorized', { status: 401 })
  }
  const dryRun = new URL(req.url).searchParams.get('dry_run') === '1'

  try {
    const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })

    if (dryRun) {
      const { count, error } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('pushed_at', null)
      if (error) throw new Error(`baca antrean: ${error.message}`)
      return Response.json({ dryRun: true, waiting: count ?? 0 })
    }

    webpush.setVapidDetails(need('VAPID_SUBJECT'), need('VAPID_PUBLIC_KEY'), need('VAPID_PRIVATE_KEY'))

    const deps: Deps = {
      now: () => Date.now(),
      async readPending(limit) {
        const { data, error } = await sb.from('notifications')
          .select('id, user_id, type, title, body, task_id, created_at')
          .is('pushed_at', null).order('created_at').limit(limit)
        if (error) throw new Error(`baca notifikasi: ${error.message}`)
        return data as Notif[]
      },
      async readSubs(userIds) {
        const { data, error } = await sb.from('push_subscriptions')
          .select('endpoint, user_id, p256dh, auth_secret').in('user_id', userIds)
        if (error) throw new Error(`baca langganan: ${error.message}`)
        return data as Sub[]
      },
      async send(sub, payload) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } },
            JSON.stringify(payload),
            { TTL: 3600, urgency: 'high' }, // 'normal' bisa ditunda lama oleh Doze Android saat HP diam
          )
          return 'ok'
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode
          return status === 404 || status === 410 ? 'gone' : 'error'
        }
      },
      async markPushed(ids) {
        const { error } = await sb.from('notifications').update({ pushed_at: new Date().toISOString() }).in('id', ids)
        if (error) throw new Error(`tandai terkirim: ${error.message}`)
      },
      async removeSubs(endpoints) {
        const { error } = await sb.from('push_subscriptions').delete().in('endpoint', endpoints)
        if (error) throw new Error(`hapus langganan: ${error.message}`)
      },
    }

    const result = await deliver(deps)
    console.log(JSON.stringify(result))
    return Response.json(result)
  } catch (e) {
    console.error(e)
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
})
