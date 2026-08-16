import { expect, it } from 'vitest'

// Placeholder kept in place of a temporary diagnostic file that could not be
// deleted while a file lock was held. Safe to remove once the lock clears.
it('placeholder: no-op', () => {
  expect(1).toBe(1)
})
