import { useRef, type ReactNode } from 'react'

interface ModalBackdropProps {
  children: ReactNode
  className: string
  onDismiss: () => void
}

export default function ModalBackdrop({
  children,
  className,
  onDismiss,
}: ModalBackdropProps): JSX.Element {
  const startedOnBackdrop = useRef(false)
  const endedOnBackdrop = useRef(false)

  return (
    <div
      className={className}
      onMouseDown={(event) => {
        startedOnBackdrop.current = event.target === event.currentTarget
        endedOnBackdrop.current = false
      }}
      onMouseUp={(event) => {
        endedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (
          startedOnBackdrop.current &&
          endedOnBackdrop.current &&
          event.target === event.currentTarget
        )
          onDismiss()
        startedOnBackdrop.current = false
      }}
    >
      {children}
    </div>
  )
}
