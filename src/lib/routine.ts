import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { todayWib, weekRange } from './date'

export type Template = { id: number; key: string; name: string; frequency: 'daily' | 'weekly'; mode: 'whole' | 'per_subject'; version: number; subject_noun: string; created_by: string | null }
export type Subject = { id: number; template_id: number; key: string; label: string; sort: number }
export type Item = {
  id: number; template_id: number; section: string; label: string
  kind: 'check' | 'check_na' | 'number' | 'text'; unit: string | null; scope: 'run' | 'subject'; sort: number
}
export type Run = { id: string; template_id: number; period: string; inspector_id: string; ng_count: number; submitted_at: string }
export type Ans = { status?: 'ok' | 'ng' | 'na'; num?: string; note?: string }
export type Answers = Record<string, Ans>

export const ansKey = (itemId: number, subjectId: number | null) => `${itemId}:${subjectId ?? 0}`

// Periode berjalan menurut WIB: harian = hari ini, mingguan = Senin minggu ini (sama dengan database)
export const currentPeriod = (t: Template) => (t.frequency === 'weekly' ? weekRange(todayWib()).start : todayWib())

export type Catalog = { templates: Template[]; items: Item[]; subjects: Subject[] }

export async function loadCatalog(): Promise<Catalog> {
  const [t, i, s] = await Promise.all([
    supabase.from('routine_templates').select('id, key, name, frequency, mode, version, subject_noun, created_by').eq('is_active', true).order('sort'),
    supabase.from('routine_items').select('id, template_id, section, label, kind, unit, scope, sort').eq('is_active', true).order('sort'),
    supabase.from('routine_subjects').select('id, template_id, key, label, sort').eq('is_active', true).order('sort'),
  ])
  const e = t.error ?? i.error ?? s.error
  if (e) throw new Error(e.message)
  return { templates: (t.data ?? []) as Template[], items: (i.data ?? []) as Item[], subjects: (s.data ?? []) as Subject[] }
}

// Tab Rutin hanya tampil bila RLS mengizinkan membaca checklist (tim ME dan pimpinan)
export function useRoutineAccess(userId: string | undefined): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    if (!userId) return
    let off = false
    supabase.from('routine_templates').select('id', { count: 'exact', head: true }).then(({ count }) => {
      if (!off) setOk((count ?? 0) > 0)
    })
    return () => { off = true }
  }, [userId])
  return ok
}

// Semua pasangan butir x objek yang wajib dijawab (butir teks opsional)
export function expectedKeys(items: Item[], subjects: Subject[]): { key: string; item: Item; subjectId: number | null }[] {
  const out: { key: string; item: Item; subjectId: number | null }[] = []
  for (const item of items) {
    if (item.kind === 'text') continue
    if (item.scope === 'run') out.push({ key: ansKey(item.id, null), item, subjectId: null })
    else for (const s of subjects) out.push({ key: ansKey(item.id, s.id), item, subjectId: s.id })
  }
  return out
}

export function isAnswered(item: Item, a: Ans | undefined): boolean {
  if (!a?.status) return false
  if (a.status === 'ng') return !!a.note?.trim()
  if (item.kind === 'number' && a.status === 'ok') return !!a.num?.trim() && Number.isFinite(Number(a.num.replace(',', '.')))
  return true
}

export function buildPayload(items: Item[], subjects: Subject[], answers: Answers) {
  const out: Record<string, unknown>[] = []
  for (const { key, item, subjectId } of expectedKeys(items, subjects)) {
    const a = answers[key]
    if (!a?.status) continue
    out.push({
      item_id: item.id, subject_id: subjectId, status: a.status,
      num: item.kind === 'number' && a.status === 'ok' ? Number((a.num ?? '').replace(',', '.')) : null,
      note: a.note?.trim() || null,
    })
  }
  // butir teks: hanya yang diisi
  for (const item of items.filter((i) => i.kind === 'text')) {
    for (const sid of item.scope === 'run' ? [null] : subjects.map((s) => s.id)) {
      const note = answers[ansKey(item.id, sid)]?.note?.trim()
      if (note) out.push({ item_id: item.id, subject_id: sid, status: 'ok', num: null, note })
    }
  }
  return out
}

// Draf di HP (localStorage): isian setengah jalan tidak hilang saat layar ditutup atau sinyal putus.
// picked = objek yang dipilih untuk diperiksa (mode per_subject, mis. kamar yang bisa dicek minggu ini).
export type Draft = { answers: Answers; picked: number[] }
const draftKey = (userId: string, tk: string, period: string) => `routine:${userId}:${tk}:${period}`
export function loadDraft(userId: string, tk: string, period: string): Draft {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(userId, tk, period)) ?? 'null') as Record<string, unknown> | null
    if (!raw) return { answers: {}, picked: [] }
    if (raw.answers && typeof raw.answers === 'object') return { answers: raw.answers as Answers, picked: Array.isArray(raw.picked) ? (raw.picked as number[]) : [] }
    return { answers: raw as Answers, picked: [] } // format lama: hanya jawaban
  } catch { return { answers: {}, picked: [] } }
}
export function saveDraft(userId: string, tk: string, period: string, d: Draft) {
  try { localStorage.setItem(draftKey(userId, tk, period), JSON.stringify(d)) } catch { /* penyimpanan penuh/diblokir: abaikan */ }
}
export function clearDraft(userId: string, tk: string, period: string) {
  try { localStorage.removeItem(draftKey(userId, tk, period)) } catch { /* abaikan */ }
}

// Objek (kamar atau panel) yang sudah diperiksa pada periode ini oleh siapa pun di tim
export async function loadDoneSubjects(templateId: number, period: string): Promise<Set<number>> {
  const { data, error } = await supabase.from('routine_run_subjects').select('subject_id').eq('template_id', templateId).eq('period', period).limit(500)
  if (error) throw new Error(error.message)
  return new Set(((data ?? []) as { subject_id: number }[]).map((r) => r.subject_id))
}

export async function loadRunAnswers(runId: string): Promise<Answers> {
  const { data, error } = await supabase.from('routine_answers').select('item_id, subject_id, status, num, note').eq('run_id', runId).limit(3000)
  if (error) throw new Error(error.message)
  const out: Answers = {}
  for (const r of (data ?? []) as { item_id: number; subject_id: number | null; status: 'ok' | 'ng' | 'na'; num: number | null; note: string | null }[]) {
    out[ansKey(r.item_id, r.subject_id)] = { status: r.status, num: r.num == null ? undefined : String(r.num), note: r.note ?? undefined }
  }
  return out
}

export const capitalize = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)
