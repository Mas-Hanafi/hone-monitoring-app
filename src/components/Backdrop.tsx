import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Dirender ke <body>: .content memakai backdrop-filter + transform, yang membuat
// position:fixed anak-anaknya mengacu ke kartu itu, bukan ke layar (lembar jadi kepotong).
export function Backdrop({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return createPortal(
    <div className="backdrop" onClick={onClick}>{children}</div>,
    document.body,
  )
}
