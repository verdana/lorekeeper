/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ModalBackdrop from '../../src/renderer/src/components/ModalBackdrop'

describe('ModalBackdrop', () => {
  it('dismisses only when the press and click both occur on the backdrop', () => {
    const onDismiss = vi.fn()
    const { container } = render(
      <ModalBackdrop className="backdrop" onDismiss={onDismiss}>
        <div>Modal content</div>
      </ModalBackdrop>,
    )
    const backdrop = container.firstElementChild!
    const content = screen.getByText('Modal content')

    fireEvent.mouseDown(content)
    fireEvent.mouseUp(backdrop)
    fireEvent.click(backdrop)
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.mouseDown(backdrop)
    fireEvent.mouseUp(content)
    fireEvent.click(backdrop)
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.mouseDown(backdrop)
    fireEvent.mouseUp(backdrop)
    fireEvent.click(backdrop)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
