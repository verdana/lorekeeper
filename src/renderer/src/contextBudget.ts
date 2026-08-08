// Context budget allocator shared by the AI writing panels (outline-write /
// continue / rewrite). Kept as its own module so it stays unit-testable
// without dragging in any writing engine.

export const CONTEXT_BUDGET = 12000

export interface ContextAllocatorWeights {
  settings: number
  outline: number
  timeline: number
  memories: number
}

export interface ContextInputs {
  settings: string
  outline: string
  timeline: string
  memories: string
  prevChapters: string
}

export interface BudgetedContext extends ContextInputs {
  truncated: boolean
}

/**
 * Proportional budget allocator: each named input gets a fixed share of
 * CONTEXT_BUDGET (head-first), `prev` keeps whatever remains (tail-first, so
 * the closest chapters' endings survive). Weights should sum to < 1.
 */
export function createContextAllocator(weights: ContextAllocatorWeights) {
  return (inputs: ContextInputs): BudgetedContext => {
    const parts: { key: keyof ContextInputs; text: string; budget: number; fromEnd: boolean }[] = [
      { key: 'settings', text: inputs.settings, budget: weights.settings, fromEnd: false },
      { key: 'outline', text: inputs.outline, budget: weights.outline, fromEnd: false },
      { key: 'timeline', text: inputs.timeline, budget: weights.timeline, fromEnd: false },
      { key: 'memories', text: inputs.memories, budget: weights.memories, fromEnd: false },
    ]
    parts.push({ key: 'prevChapters', text: inputs.prevChapters, budget: 0, fromEnd: true })

    const total = parts.reduce((sum, p) => sum + p.text.length, 0)
    if (total <= CONTEXT_BUDGET) {
      return { ...inputs, truncated: false }
    }
    const result: ContextInputs = { ...inputs }
    let used = 0
    for (const p of parts) {
      if (p.key === 'prevChapters') {
        // prev keeps whatever remains, taken from the end (most recent first).
        result.prevChapters = p.text.slice(-(CONTEXT_BUDGET - used))
        continue
      }
      const cap = Math.floor(CONTEXT_BUDGET * p.budget)
      const sliced = p.text.slice(0, cap)
      result[p.key] = sliced
      used += sliced.length
    }
    return { ...result, truncated: true }
  }
}
