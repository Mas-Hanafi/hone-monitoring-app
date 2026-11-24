import { supabase } from './supabase'
import { urlBase64ToUint8Array } from './vapid'

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

// serviceWorker.ready tidak pernah selesai kalau belum ada service worker (mode dev, atau kunjungan pertama).
// Tanpa batas waktu, keluar akun ikut menggantung selamanya.
async function swReady(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ])
}

export type PushState = 'no-key' | 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on'

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export async function pushState(): Promise<PushState> {
  if (!VAPID_PUBLIC) return 'no-key'
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  // iPhone hanya mendukung push untuk app yang sudah dipasang ke layar utama
  if (!capable) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await swReady()
  if (!reg) return 'unsupported'
  const sub = await reg.pushManager.getSubscription()
  return Notification.permission === 'granted' && sub ? 'on' : 'off'
}

async function save(sub: PushSubscription): Promise<string | null> {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'Langganan push tidak lengkap.'
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
  })
  return error ? error.message : null
}

// Harus dipanggil dari klik pengguna (syarat browser untuk meminta izin).
export async function enablePush(): Promise<string | null> {
  if (!VAPID_PUBLIC) return 'Kunci push belum dipasang di app.'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'Izin notifikasi tidak diberikan. Ubah lewat pengaturan browser.'
  const reg = await swReady()
  if (!reg) return 'Service worker belum aktif. Muat ulang halaman lalu coba lagi.'
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) }))
  return save(sub)
}

export async function disablePush(): Promise<void> {
  const reg = await swReady()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint })
  await sub.unsubscribe()
}

// Saat masuk di perangkat yang sudah punya langganan: daftarkan atas nama akun yang sedang login
// (perangkat bersama: push akun sebelumnya tidak boleh nyasar ke akun ini, dan sebaliknya).
export async function syncPushOwner(): Promise<void> {
  if (!VAPID_PUBLIC || !('serviceWorker' in navigator) || !('PushManager' in window)) return
  if (Notification.permission !== 'granted') return
  const reg = await swReady()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) await save(sub)
}

// Saat keluar akun: lepas perangkat ini dari akun itu di server. Langganan browser dibiarkan,
// jadi akun berikutnya tidak perlu meminta izin lagi (syncPushOwner memindahkannya).
export async function releasePushForSignOut(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    const reg = await swReady()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint })
  } catch {
    /* gagal (misalnya offline) tidak boleh menghalangi keluar akun */
  }
}
