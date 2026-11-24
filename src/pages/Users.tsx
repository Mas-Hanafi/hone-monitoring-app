import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { EditUserSheet } from '../components/EditUserSheet'
import { InviteSheet } from '../components/InviteSheet'
import { Skeleton } from '../components/Skeleton'
import { presenceInfo, usePresence } from '../lib/presence'
import { ROLE_LABEL, type Department, type UserRow } from '../lib/types'

// Khusus Developer (tab hanya muncul untuk Developer; RLS tetap membatasi di database).
export function Users() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const { seen, signedIn, now } = usePresence()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [u, d] = await Promise.all([
      supabase.from('profiles')
        .select('id, full_name, role, department_id, is_active, dept:departments(name)')
        .order('is_active', { ascending: false })
        .order('full_name'),
      supabase.from('departments').select('id, name').eq('is_active', true).order('sort_order'),
    ])
    if (u.error || d.error) setError((u.error ?? d.error)?.message ?? 'Gagal memuat')
    else {
      setUsers(u.data as unknown as UserRow[])
      setDepartments(d.data as Department[])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <>
      <div className="row">
        <h2 className="title">Pengguna</h2>
        <button type="button" className="primary" onClick={() => setInviting(true)}>+ Akun</button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && users.length === 0 && <Skeleton rows={5} />}

      <ul className="list">
        {users.map((u) => {
          const pr = presenceInfo(seen[u.id], now, signedIn[u.id])
          return (
          <li key={u.id}>
            <button type="button" className={u.is_active ? 'card' : 'card inactive'} onClick={() => setEditing(u)}>
              <div className="row">
                <strong>
                  <span className={pr.online ? 'dot on' : 'dot'} role="img" aria-label={pr.online ? 'Online' : 'Offline'} />
                  {u.full_name}
                </strong>
                <span className="tag role">{ROLE_LABEL[u.role]}</span>
              </div>
              <div className="meta">
                {u.dept?.name ?? '-'}
                {u.is_active ? '' : ' · nonaktif'}
              </div>
              <div className={pr.online ? 'meta seen on' : 'meta seen'}>{pr.text}</div>
            </button>
          </li>
          )
        })}
      </ul>

      {inviting && (
        <InviteSheet
          departments={departments}
          onClose={() => setInviting(false)}
          onInvited={() => {
            setInviting(false)
            load()
          }}
        />
      )}
      {editing && (
        <EditUserSheet
          user={editing}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </>
  )
}
