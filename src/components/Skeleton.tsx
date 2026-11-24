// Kerangka pemuatan: kartu kaca berkilau menggantikan tulisan "Memuat…" (lihat .skeleton di glass.css)
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="list skeleton" role="status" aria-label="Memuat">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="card sk">
          <i className="sk-line w60" />
          <i className="sk-line w40" />
          <i className="sk-bar" />
        </li>
      ))}
    </ul>
  )
}
