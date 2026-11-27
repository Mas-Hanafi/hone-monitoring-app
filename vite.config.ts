import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Penanda versi yang tampil di header: tanggal dan jam build (WIB), supaya terlihat apakah pembaruan sudah terpasang.
const BUILD = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [react(), VitePWA({
    registerType: 'prompt', // versi baru menunggu tombol "Perbarui" (lihat src/lib/pwa.ts)
    manifest: {
      name: 'H One Monitoring Apps',
      short_name: 'H One', // label ikon di layar utama: nama panjang akan terpotong
      description: 'Monitoring tugas dan project staff',
      lang: 'id',
      display: 'standalone',
      start_url: '/',
      background_color: '#f6f7f9',
      theme_color: '#1f6feb',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, // transparan
        { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, // latar hitam penuh, H putih di zona aman: ikon Android tidak terpotong
      ],
    },
    // Data API tidak di-cache: data kinerja harus selalu dari server.
    workbox: {
      importScripts: ['push-sw.js'], // handler push + klik notifikasi (public/push-sw.js)
      navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/storage\//],
      // Bagian pustaka PDF yang tidak dipakai laporan (jsPDF memuatnya hanya untuk doc.html()): jangan ikut diunduh ke setiap HP
      globIgnores: ['**/html2canvas-*.js', '**/purify.es-*.js', '**/index.es-*.js'],
    },
  })],
})