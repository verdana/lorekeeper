import { create } from 'zustand'

export type ToastType = 'error' | 'success' | 'info'

export interface Toast {
  id: string
  type: ToastType
  message: string
}

interface ToastState {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

let nextId = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `t_${++nextId}`
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    const ms = toast.type === 'error' ? 8000 : 3500
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, ms)
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

/**
 * Extract a user-friendly message from AI error responses.
 * Server truncates response bodies at 300 chars, so the JSON may be cut off
 * (missing closing braces). Handles both complete and truncated cases.
 *
 * Input example:
 *   AI request failed (429): {"error":{"code":"AccountQuotaExceeded","message":"You have exceeded..."}}
 *
 * Strategy:
 *   1. Try parsing the full JSON object (complete response).
 *   2. Try regex extraction of the "message" field (works on truncated JSON).
 *   3. Strip the "AI request failed (NNN): " prefix as fallback.
 */
export function parseAiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  // 1. Try complete JSON parse: find {...} with balanced braces.
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0])
      const msg = obj?.error?.message
      if (msg) return msg
    } catch {
      /* fall through to regex extraction */
    }
  }

  // 2. Regex extraction: works even on truncated JSON.
  //    Matches "message":"<value>" where value doesn't contain unescaped quotes.
  const msgMatch = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (msgMatch) {
    // Unescape common JSON escapes within the captured value.
    return msgMatch[1].replace(/\\(.)/g, '$1')
  }

  // 3. Fallback: strip the technical prefix, keep the payload.
  const stripped = raw.replace(/^AI request failed \(\d+\):\s*/, '')
  return stripped || raw
}

// Convenience helpers so callers don't need to import the store directly
export function toastError(message: string): void {
  useToastStore.getState().addToast({ type: 'error', message })
}

export function toastSuccess(message: string): void {
  useToastStore.getState().addToast({ type: 'success', message })
}

export function toastInfo(message: string): void {
  useToastStore.getState().addToast({ type: 'info', message })
}
