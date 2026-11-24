const MAX_SIDE = 1280
const JPEG_QUALITY = 0.7

// Kompres di HP sebelum unggah (target ~300 KB; bucket menolak > 1,5 MB)
// dan tempel watermark nama, waktu, dan tugas. Waktu watermark dari jam HP
// hanya penanda visual; waktu yang sah adalah created_at dari server.
export async function compressPhoto(file: File, label: string): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas tidak tersedia di perangkat ini')
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()

  const fontPx = Math.max(14, Math.round(w / 40))
  const barH = fontPx * 1.9
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(0, h - barH, w, barH)
  ctx.fillStyle = '#fff'
  ctx.font = `${fontPx}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(label, fontPx * 0.6, h - barH / 2, w - fontPx)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  if (!blob) throw new Error('Gagal memproses foto')
  return blob
}
