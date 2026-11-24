// Edge Function terjadwal: hapus foto kedaluwarsa dan file yatim.
// Deploy: supabase functions deploy cleanup-photos --no-verify-jwt
// Secret : supabase secrets set CRON_SECRET=<string-acak-panjang>
// Uji    : POST ...?dry_run=1 dengan header x-cron-secret (hanya melaporkan, tidak menghapus)
// Dipicu pg_cron lewat supabase/cron.sql. Tanpa JWT, jadi dijaga CRON_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { cleanup } from './cleanup.ts';

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  const dryRun = new URL(req.url).searchParams.get('dry_run') === '1';
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  try {
    const result = await cleanup(sb, { dryRun });
    console.log(JSON.stringify(result));
    return Response.json(result);
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
