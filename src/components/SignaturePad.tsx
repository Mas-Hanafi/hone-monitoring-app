import { useEffect, useRef, useState } from 'react'

// Kanvas tanda tangan: digambar dengan jari atau mouse (pointer events), diekspor sebagai PNG berlatar putih
// supaya terbaca di laporan cetak. onChange(null) saat dikosongkan.
export function SignaturePad({ onChange }: { onChange: (b: Blob | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [empty, setEmpty] = useState(true)

  const reset = () => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
  }
  useEffect(reset, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ref.current as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
  }
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    const p = pos(e)
    last.current = p
    line(p, { x: p.x + 0.01, y: p.y }) // titik tunggal
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return
    const p = pos(e)
    line(last.current, p)
    last.current = p
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    setEmpty(false)
    ref.current?.toBlob((b) => onChange(b), 'image/png')
  }
  const clear = () => {
    reset()
    setEmpty(true)
    onChange(null)
  }

  return (
    <div className="sig">
      <canvas ref={ref} width={640} height={240} className="sig-canvas" aria-label="Area tanda tangan"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="row">
        <span className="meta">{empty ? 'Tanda tangan di dalam kotak' : 'Tanda tangan terekam'}</span>
        <button type="button" className="ghost" onClick={clear} disabled={empty}>Hapus</button>
      </div>
    </div>
  )
}
