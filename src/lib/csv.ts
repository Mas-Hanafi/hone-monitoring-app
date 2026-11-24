export type Cell = string | number | null | undefined

// Sel teks yang diawali = + - @ dianggap rumus oleh Excel/Sheets (CSV injection).
// Diberi awalan ' supaya tampil sebagai teks. Angka tidak disentuh.
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: Cell, sep = ';'): string {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return /["\r\n]/.test(text) || text.includes(sep) ? `"${text.replace(/"/g, '""')}"` : text
}

// Pemisah titik koma: terbuka benar di Excel dengan pengaturan regional Indonesia.
export function toCsv(headers: string[], rows: Cell[][], sep = ';'): string {
  return [headers, ...rows].map((r) => r.map((c) => csvCell(c, sep)).join(sep)).join('\r\n') + '\r\n'
}

// BOM UTF-8 supaya Excel membaca karakter non-ASCII dengan benar
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
