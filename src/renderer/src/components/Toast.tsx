import { XCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useToastStore, type ToastType } from '../toast'
import clsx from 'clsx'

const ICONS: Record<ToastType, typeof XCircle> = {
  error: XCircle,
  success: CheckCircle2,
  info: Info
}

const COLOR: Record<ToastType, string> = {
  error: 'border-star-danger/40',
  success: 'border-star-success/40',
  info: 'border-star-info/40'
}

const ICON_COLOR: Record<ToastType, string> = {
  error: 'text-star-danger',
  success: 'text-star-success',
  info: 'text-star-info'
}

export default function Toaster(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return <></>

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => {
        const Icon = ICONS[t.type]
        return (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-lg border shadow-lg toast-enter',
              COLOR[t.type]
            )}
            style={{
              background: 'var(--surface-raised)',
              boxShadow: 'var(--shadow-warm-lg)'
            }}
          >
            <Icon size={16} className={clsx('shrink-0 mt-0.5', ICON_COLOR[t.type])} />
            <span className="flex-1 text-sm leading-snug text-ink-body break-words overflow-hidden">{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              className="shrink-0 text-ink-500 hover:text-ink-muted transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
