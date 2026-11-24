export type Role = 'staff' | 'supervisor' | 'manager' | 'developer'

export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'on_hold'
  | 'done'
  | 'handover'
  | 'cancelled'

export type Approval = 'pending' | 'approved' | 'hold' | 'rejected'

export const APPROVAL_LABEL: Record<Approval, string> = {
  pending: 'Pending',
  approved: 'Approve',
  hold: 'Hold',
  rejected: 'Reject',
}

export interface Profile {
  id: string
  full_name: string
  role: Role
  department_id: number
}

export interface UserRow extends Profile {
  is_active: boolean
  dept: { name: string } | null
}

export interface Task {
  id: string
  task_no: number
  title: string
  status: TaskStatus
  approval: Approval
  pic_id: string
  pic_department_id: number
  requester_department_id: number
  progress: number
  is_urgent: boolean
  deadline: string // YYYY-MM-DD
  original_deadline: string
  latest_note: string | null
  last_update_at: string
  pic: { full_name: string } | null
  dept: { name: string } | null
  req: { name: string } | null
}

export interface Department {
  id: number
  name: string
}

export interface PicOption {
  id: string
  full_name: string
  department_id: number
  dept: { name: string } | null
}

export const CREATOR_ROLES: Role[] = ['supervisor', 'manager', 'developer']

export const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: 'Belum dimulai',
  in_progress: 'Dikerjakan',
  on_hold: 'Hold',
  done: 'Selesai',
  handover: 'Handover',
  cancelled: 'Dibatalkan',
}

export const ROLE_LABEL: Record<Role, string> = {
  staff: 'Staff',
  supervisor: 'SPV',
  manager: 'Manager',
  developer: 'Developer',
}

export const ACTIVE_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'on_hold']
export const CLOSED_STATUSES: TaskStatus[] = ['done', 'handover', 'cancelled']
