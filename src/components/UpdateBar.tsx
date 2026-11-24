import { applyUpdate, useUpdateReady } from '../lib/pwa'

export function UpdateBar() {
  if (!useUpdateReady()) return null
  return (
    <div className="update-bar" role="status">
      <span>Versi baru tersedia.</span>
      <button type="button" onClick={applyUpdate}>Perbarui</button>
    </div>
  )
}
