import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  initPaths,
  reviewQueueFile,
  setCurrentWorldId,
} from '../../src/server/paths'
import { readReviewQueue, writeReviewQueue } from '../../src/server/store'
import type { ReviewQueueStore } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_test'

const queue = (): ReviewQueueStore => ({
  version: 1,
  items: [
    {
      id: 'rq_1',
      reportId: 'c_1',
      reportLabel: '08/12 14:30',
      severity: 'critical',
      text: 'Name drift',
      relatedDocIds: ['character/ari.md'],
      status: 'open',
      fixedIn: null,
      note: '',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
})

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-review-queue-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

describe('review queue store', () => {
  it('round-trips the queue through review-queue.json', () => {
    writeReviewQueue(queue())
    expect(existsSync(reviewQueueFile())).toBe(true)
    expect(readReviewQueue()).toEqual(queue())
  })

  it('returns an empty queue when the file is missing or corrupt', () => {
    if (existsSync(reviewQueueFile())) rmSync(reviewQueueFile())
    expect(readReviewQueue()).toEqual({ version: 1, items: [] })

    writeFileSync(reviewQueueFile(), '{oops')
    expect(readReviewQueue()).toEqual({ version: 1, items: [] })
  })

  it('drops malformed items on read', () => {
    writeFileSync(
      reviewQueueFile(),
      JSON.stringify({
        version: 1,
        items: [queue().items[0], { id: 'rq_bad', severity: 'nope', status: 'open' }, null],
      }),
    )
    const result = readReviewQueue()
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('rq_1')
  })
})
