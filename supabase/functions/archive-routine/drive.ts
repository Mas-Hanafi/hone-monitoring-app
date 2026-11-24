// Klien Google Sheets v4 dengan service account + jembatan Apps Script untuk berkas Drive. Tanpa pustaka: fetch + Web Crypto.
export interface ServiceAccount { client_email: string; private_key: string }
type Fetch = typeof fetch

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function pemToDer(pem: string): ArrayBuffer {
  const bin = atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}
// Pesan error dipotong dan tidak pernah memuat kunci/token.
async function fail(what: string, res: Response): Promise<never> {
  throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
}

export async function getAccessToken(sa: ServiceAccount, f: Fetch = fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 }))
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`))
  const res = await f(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
  })
  if (!res.ok) await fail('token Google', res)
  return (await res.json()).access_token as string
}

// Jembatan ke Google Apps Script milik pemilik Drive: service account tidak punya kuota penyimpanan Drive,
// jadi berkas disimpan oleh skrip yang berjalan sebagai akun pemilik (kuota akun itu). Lihat apps-script/Code.gs.
export interface Bridge {
  folder(rootId: string, path: string[]): Promise<{ folderUrl: string }>
  upload(rootId: string, path: string[], name: string, bytes: Uint8Array, type: string): Promise<{ id: string; url: string; folderUrl: string }>
  ping(rootId: string): Promise<{ ok: boolean }>
}

const toB64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function bridgeClient(url: string, token: string, f: Fetch = fetch): Bridge {
  async function call(payload: Record<string, unknown>): Promise<Record<string, string | boolean>> {
    const res = await f(url, { method: 'POST', redirect: 'follow', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token, ...payload }) })
    if (!res.ok) await fail('jembatan Drive', res)
    const j = await res.json()
    if (j.error) throw new Error(`jembatan Drive: ${String(j.error).slice(0, 200)}`)
    return j
  }
  return {
    folder: async (rootId, path) => ({ folderUrl: (await call({ action: 'folder', rootId, path })).folderUrl as string }),
    upload: async (rootId, path, name, bytes, type) => {
      const j = await call({ action: 'upload', rootId, path, name, type, data: toB64(bytes) })
      return { id: j.id as string, url: j.url as string, folderUrl: j.folderUrl as string }
    },
    ping: async (rootId) => ({ ok: (await call({ action: 'ping', rootId })).ok === true }),
  }
}

export function sheetsClient(token: string, sheetId: string, tab: string, headers: string[], f: Fetch = fetch) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const quoted = `'${tab.replace(/'/g, "''")}'`
  let ready = false

  async function ensure(): Promise<void> {
    if (ready) return
    const meta = await f(`${base}?fields=sheets.properties.title`, { headers: h })
    if (!meta.ok) await fail('baca Sheet', meta)
    const titles = ((await meta.json()).sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title)
    if (!titles.includes(tab)) {
      const add = await f(`${base}:batchUpdate`, {
        method: 'POST', headers: h, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
      })
      if (!add.ok) await fail('buat tab', add)
    }
    // header ditulis ulang tiap proses supaya kolom baru ikut tanpa menyentuh baris data
    const w = await f(`${base}/values/${encodeURIComponent(`${quoted}!A1`)}?valueInputOption=RAW`, {
      method: 'PUT', headers: h, body: JSON.stringify({ values: [headers] }),
    })
    if (!w.ok) await fail('tulis header', w)
    ready = true
  }

  return {
    async existingIds(): Promise<Set<string>> {
      await ensure()
      const res = await f(`${base}/values/${encodeURIComponent(`${quoted}!A:A`)}`, { headers: h })
      if (!res.ok) await fail('baca ID isian', res)
      return new Set(((await res.json()).values ?? []).map((r: string[]) => r[0]))
    },
    async append(rows: string[][]): Promise<void> {
      await ensure()
      // RAW: teks pengguna tidak pernah dijalankan sebagai rumus
      const res = await f(`${base}/values/${encodeURIComponent(`${quoted}!A:A`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', headers: h, body: JSON.stringify({ values: rows }),
      })
      if (!res.ok) await fail('tambah baris', res)
    },
  }
}
