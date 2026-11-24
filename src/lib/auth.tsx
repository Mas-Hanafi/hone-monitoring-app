import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { cacheDel, cacheGet, cachePut, clearCache } from './offline'
import { classifyRpcError } from './queue'
import { releasePushForSignOut } from './push'
import type { Profile } from './types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  needsPassword: boolean // datang dari tautan undangan / reset sandi
  passwordSet: () => void
  signOut: () => Promise<void>
}

// Dibaca saat modul dimuat, sebelum supabase-js membersihkan hash URL
const ARRIVED_VIA_LINK = /type=(invite|recovery)/.test(window.location.hash)

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsPassword, setNeedsPassword] = useState(ARRIVED_VIA_LINK)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
      setSession(s)
      if (!s) setLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const uid = session?.user.id
  useEffect(() => {
    if (!uid) {
      setProfile(null)
      return
    }
    let cancelled = false
    supabase
      .from('profiles')
      .select('id, full_name, role, department_id')
      .eq('id', uid)
      .maybeSingle()
      .then(async ({ data, error }) => {
        // Tanpa sinyal: pakai salinan profil terakhir supaya app tetap bisa dibuka (server tetap menegakkan hak akses)
        if (error && classifyRpcError(error).kind === 'transient') {
          const cached = await cacheGet<Profile>(`profile:${uid}`)
          if (!cancelled) {
            setProfile(cached?.value ?? null)
            setLoading(false)
          }
          return
        }
        if (cancelled) return
        // Akun nonaktif atau tanpa profil: RLS mengembalikan kosong
        const p = error ? null : (data as Profile | null)
        setProfile(p)
        if (p) void cachePut(`profile:${uid}`, p)
        else void cacheDel(`profile:${uid}`)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  const signOut = async () => {
    await releasePushForSignOut() // sebelum sesi dicabut, karena butuh login
    await supabase.auth.signOut()
    await clearCache()
  }

  return <AuthCtx.Provider value={{ session, profile, loading, needsPassword, passwordSet: () => setNeedsPassword(false), signOut }}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth harus di dalam AuthProvider')
  return ctx
}
