// Ambil pesan error dari respons Edge Function (supabase-js membungkusnya sebagai error generik)
export async function functionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.json()) as { error?: string }
      if (body.error) return body.error
    } catch {
      /* bukan JSON: pakai pesan bawaan */
    }
  }
  return error instanceof Error ? error.message : 'Gagal menghubungi server.'
}
