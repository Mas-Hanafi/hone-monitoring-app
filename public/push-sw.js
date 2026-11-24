// Ditambahkan ke service worker hasil build lewat workbox.importScripts (lihat vite.config.ts).
// Menangani push yang diterima saat app tertutup dan klik pada notifikasinya.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'H One Monitoring Apps', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof data.url === 'string' ? data.url : '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // Hanya alamat relatif di app ini; apa pun selain itu jatuh ke halaman utama
  const raw = (event.notification.data && event.notification.data.url) || '/'
  const url = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) return w.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
