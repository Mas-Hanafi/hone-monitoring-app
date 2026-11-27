import { useEffect, useRef, useState } from 'react'
import { useAuth } from './lib/auth'
import { CREATOR_ROLES } from './lib/types'
import { Dashboard } from './pages/Dashboard'
import { ChangePasswordSheet } from './components/ChangePasswordSheet'
import { NotificationBell } from './components/NotificationBell'
import { SyncBanner } from './components/SyncBanner'
import { useOutbox } from './lib/offline'
import { Login } from './pages/Login'
import { Reports } from './pages/Reports'
import { Logbook } from './pages/Logbook'
import { Routine } from './pages/Routine'
import { useRoutineAccess } from './lib/routine'
import { useOpenCount } from './lib/logbook'
import { SetPassword } from './pages/SetPassword'
import { Tasks, type Preset } from './pages/Tasks'
import { Users } from './pages/Users'
import { Activity } from './pages/Activity'
import { usePresenceHeartbeat } from './lib/presence'

export default function App() {
  const { session, profile, loading, needsPassword, signOut } = useAuth()
  const { items: outbox } = useOutbox(profile?.id)
  // null = belum memilih: SPV/Manager/Developer mulai di Ringkasan, staff di Tugas
  const [tab, setTab] = useState<'tasks' | 'summary' | 'routine' | 'logbook' | 'reports' | 'users' | 'activity' | null>(null)
  const [preset, setPreset] = useState<Preset | null>(null) // filter Tugas yang dibuka dari kartu Ringkasan
  const [showPw, setShowPw] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const canRoutine = useRoutineAccess(profile?.id)
  const openLogbook = useOpenCount(canRoutine)
  usePresenceHeartbeat(!!profile)
  // Tab banyak (developer): tab aktif selalu digulir ke tengah supaya tidak terpotong
  useEffect(() => {
    navRef.current?.querySelector('button.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [tab, profile?.id])

  if (loading) return <div className="center" role="status" aria-label="Memuat"><picture><source srcSet="/hone-wordmark-white.svg" media="(prefers-color-scheme: dark)" /><img className="pulse" src="/hone-wordmark-black.svg" width="190" height="55" alt="" /></picture></div>
  if (!session) return <Login />
  if (needsPassword) return <SetPassword />
  if (!profile) {
    return (
      <main className="center">
        <p>Akun Anda belum aktif atau belum punya profil. Hubungi developer.</p>
        <button type="button" className="ghost" onClick={signOut}>Keluar</button>
      </main>
    )
  }

  const isLead = CREATOR_ROLES.includes(profile.role)
  const active = tab ?? (isLead ? 'summary' : 'tasks')
  const unsent = outbox.length
  function handleSignOut() {
    if (unsent > 0 && !window.confirm(`Ada ${unsent} update yang belum terkirim. Keluar tidak menghapusnya, tapi baru terkirim saat Anda masuk lagi. Tetap keluar?`)) return
    void signOut()
  }

  return (
    <>
      <header className="top">
        <div>
          <strong>{profile.full_name}</strong>
          <small className="ver">versi {__BUILD__}</small>
        </div>
        <div className="head-actions">
          <NotificationBell />
          <button type="button" className="ghost" onClick={() => setShowPw(true)}>Sandi</button>
          <button type="button" className="ghost" onClick={handleSignOut}>Keluar</button>
        </div>
      </header>
      {showPw && <ChangePasswordSheet onClose={() => setShowPw(false)} />}
      <SyncBanner />
      {(
        <nav className="nav" ref={navRef}>
          {isLead && (
            <button type="button" className={active === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>
              Ringkasan
            </button>
          )}
          {canRoutine && (
            <button type="button" className={active === 'routine' ? 'on' : ''} onClick={() => setTab('routine')}>
              Rutin
            </button>
          )}
          {canRoutine && (
            <button type="button" className={active === 'logbook' ? 'on' : ''} onClick={() => setTab('logbook')}>
              Logbook{openLogbook > 0 ? ` (${openLogbook})` : ''}
            </button>
          )}
          <button type="button" className={active === 'tasks' ? 'on' : ''} onClick={() => { setPreset(null); setTab('tasks') }}>
            Tugas
          </button>
          {isLead && (
            <button type="button" className={active === 'reports' ? 'on' : ''} onClick={() => setTab('reports')}>
              Laporan
            </button>
          )}
          {profile.role === 'developer' && (
            <button type="button" className={active === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
              Pengguna
            </button>
          )}
          <button type="button" className={active === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
            Log
          </button>
        </nav>
      )}
      <main className="content">
        {active === 'users' && profile.role === 'developer' ? (
          <Users />
        ) : active === 'activity' ? (
          <Activity />
        ) : active === 'logbook' && canRoutine ? (
          <Logbook />
        ) : active === 'routine' && canRoutine ? (
          <Routine />
        ) : active === 'reports' && isLead ? (
          <Reports />
        ) : active === 'summary' && isLead ? (
          <Dashboard onOpen={(p) => { setPreset(p); setTab('tasks') }} />
        ) : (
          <Tasks preset={preset} />
        )}
      </main>
    </>
  )
}
