import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initPwa } from './lib/pwa'
import { AuthProvider } from './lib/auth'
import App from './App'
import { UpdateBar } from './components/UpdateBar'
import './styles.css'
import './glass.css' // tema kaca: menimpa styles.css

initPwa()

// Paralaks halus untuk foto latar: hanya desktop dengan mouse dan tanpa "kurangi gerakan" (lihat glass.css)
if (matchMedia('(hover: hover) and (pointer: fine) and (min-width: 900px) and (prefers-reduced-motion: no-preference)').matches) {
  let raf = 0
  addEventListener('pointermove', (e) => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const st = document.documentElement.style
      st.setProperty('--px', String(e.clientX / innerWidth - 0.5))
      st.setProperty('--py', String(e.clientY / innerHeight - 0.5))
    })
  }, { passive: true })
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <AuthProvider>
      <App />
      <UpdateBar />
    </AuthProvider>
  </StrictMode>,
)
