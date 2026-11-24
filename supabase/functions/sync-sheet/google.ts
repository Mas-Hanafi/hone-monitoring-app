// Klien Google Sheets API v4 dengan service account. Tanpa pustaka: hanya fetch + Web Crypto.
import { HEADERS, quoteTab, type Cell, type Update } from './sheet.ts'

export interface ServiceAccount { client_email: string; private_key: string }
type Fetch = typeof fetch

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

// Pesan error dipotong dan tidak pernah memuat kunci/token.
async function fail(what: string, res: Response): Promise<never> {
  const body = (await res.text()).slice(0, 300)
  throw new Error(`${what}: HTTP ${res.status} ${body}`)
}

export async function getAccessToken(sa: ServiceAccount, f: Fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }))
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`))
  const res = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64url(sig)}`,
    }),
  })
  if (!res.ok) await fail('token Google', res)
  return (await res.json()).access_token as string
}

export function sheetClient(token: string, sheetId: string, tab: string, f: Fetch = fetch) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const rng = (suffix: string) => encodeURIComponent(`${quoteTab(tab)}!${suffix}`)
  // RAW: nilai ditulis apa adanya. Dengan USER_ENTERED, judul tugas yang diawali "=" akan dijalankan sebagai rumus.
  const raw = 'valueInputOption=RAW'

  return {
    tab,
    async readColumnA(): Promise<unknown[][]> {
      const res = await f(`${base}/values/${rng('A:A')}?valueRenderOption=UNFORMATTED_VALUE`, { headers })
      if (!res.ok) await fail('baca Sheet', res)
      return ((await res.json()).values ?? []) as unknown[][]
    },
    async writeHeader(): Promise<void> {
      const res = await f(`${base}/values/${rng('A1')}?${raw}`, {
        method: 'PUT', headers, body: JSON.stringify({ values: [HEADERS] }),
      })
      if (!res.ok) await fail('tulis header', res)
    },
    async update(data: Update[]): Promise<void> {
      const res = await f(`${base}/values:batchUpdate`, {
        method: 'POST', headers, body: JSON.stringify({ valueInputOption: 'RAW', data }),
      })
      if (!res.ok) await fail('update baris', res)
    },
    async append(rows: Cell[][]): Promise<void> {
      const res = await f(`${base}/values/${rng('A:A')}:append?${raw}&insertDataOption=INSERT_ROWS`, {
        method: 'POST', headers, body: JSON.stringify({ values: rows }),
      })
      if (!res.ok) await fail('tambah baris', res)
    },
  }
}
