// Pembungkus IndexedDB minimal. Dua tempat penyimpanan:
//  - outbox: update yang menunggu terkirim (termasuk foto sebagai Blob)
//  - cache : salinan terakhir daftar tugas dan profil, untuk dibuka tanpa sinyal
type StoreName = 'outbox' | 'cache'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('monitoring-offline', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('outbox', { keyPath: 'id' })
      req.result.createObjectStore('cache', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export const idb = {
  getAll: <T>(store: StoreName) => run<T[]>(store, 'readonly', (s) => s.getAll()),
  get: <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key)),
  put: (store: StoreName, value: unknown) => run(store, 'readwrite', (s) => s.put(value)),
  del: (store: StoreName, key: string) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store: StoreName) => run(store, 'readwrite', (s) => s.clear()),
}
