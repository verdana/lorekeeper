import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import clsx from 'clsx'

/**
 * 全站统一的视图级空态占位。
 * 用在视图正中央（不用于侧栏内的短小 "No X yet" 提示，那种保留原样即可）。
 *
 * 结构:图标 → 标题 → 说明 → 可选的行动按钮(children 插槽)。
 * 视觉:柔和暖白 surface + 极轻暖阴影,和整体羊皮纸风一致,不喧宾夺主。
 */
export interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  children?: ReactNode // 通常放 <button> 引导用户下一步操作
  className?: string
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center px-6 py-16 gap-3',
        className
      )}
    >
      <div className="w-14 h-14 rounded-full bg-ink-850 border border-ink-800 flex items-center justify-center text-ink-600 mb-1">
        <Icon size={26} />
      </div>
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      {description && (
        <p className="text-sm text-slate-500 max-w-sm leading-relaxed">{description}</p>
      )}
      {children && <div className="mt-2 flex items-center gap-2">{children}</div>}
    </div>
  )
}
