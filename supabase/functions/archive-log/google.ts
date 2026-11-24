// Klien Google Sheets v4 (service account) dan jembatan Apps Script untuk berkas Drive. Tanpa pustaka: fetch + Web Crypto.
import { planUpsert, quoteTab, type Cell } from './format.ts'

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

export interface Bridge {
  upload(rootId: string, path: string[], name: string, bytes: Uint8Array, type: string): Promise<{ id: string; url: string; folderUrl: string }>
}
const toB64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export function bridgeClient(url: string, token: string, f: Fetch = fetch): Bridge {
  return {
    async upload(rootId, path, name, bytes, type) {
      const res = await f(url, { method: 'POST', redirect: 'follow', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token, action: 'upload', rootId, path, name, type, data: toB64(bytes) }) })
      if (!res.ok) await fail('jembatan Drive', res)
      const j = await res.json()
      if (j.error) throw new Error(`jembatan Drive: ${String(j.error).slice(0, 200)}`)
      return { id: j.id as string, url: j.url as string, folderUrl: j.folderUrl as string }
    },
  }
}

// Satu tab pada Sheet: dibuat (beserta header) bila belum ada. Kolom A berisi kunci baris.
export function tabClient(token: string, sheetId: string, tab: string, headers: readonly string[], f: Fetch = fetch) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const quoted = quoteTab(tab)
  let ready = false

  async function ensure(): Promise<void> {
    if (ready) return
    const meta = await f(`${base}?fields=sheets.properties.title`, { headers: h })
    if (!meta.ok) await fail('baca Sheet', meta)
    const titles = ((await meta.json()).sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title)
    if (!titles.includes(tab)) {
      const add = await f(`${base}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] }) })
      if (!add.ok) await fail(`buat tab ${tab}`, add)
    }
    const w = await f(`${base}/values/${encodeURIComponent(`${quoted}!A1`)}?valueInputOption=RAW`, { method: 'PUT', headers: h, body: JSON.stringify({ values: [headers] }) })
    if (!w.ok) await fail(`tulis header ${tab}`, w)
    ready = true
  }

  async function colA(): Promise<unknown[][]> {
    await ensure()
    const res = await f(`${base}/values/${encodeURIComponent(`${quoted}!A:A`)}`, { headers: h })
    if (!res.ok) await fail(`baca kolom ID ${tab}`, res)
    return (await res.json()).values ?? []
  }
  async function append(rows: Cell[][]): Promise<void> {
    if (!rows.length) return
    const res = await f(`${base}/values/${encodeURIComponent(`${quoted}!A:A`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h, body: JSON.stringify({ values: rows }) })
    if (!res.ok) await fail(`tambah baris ${tab}`, res)
  }

  return {
    // Tambah baris yang kuncinya belum ada di kolom A (aman dipanggil ulang)
    async appendNew(rows: Cell[][]): Promise<number> {
      const known = new Set((await colA()).map((r) => String(r?.[0] ?? '')))
      const fresh = rows.filter((r) => !known.has(String(r[0])))
      await append(fresh)
      return fresh.length
    },
    // Ubah baris yang kuncinya sudah ada, tambah yang belum
    async upsert(rows: Cell[][]): Promise<{ updated: number; added: number }> {
      const plan = planUpsert(await colA(), rows, tab, headers.length)
      if (plan.updates.length) {
        const res = await f(`${base}/values:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ valueInputOption: 'RAW', data: plan.updates }) })
        if (!res.ok) await fail(`ubah baris ${tab}`, res)
      }
      await append(plan.appends)
      return { updated: plan.updates.length, added: plan.appends.length }
    },
  }
}
