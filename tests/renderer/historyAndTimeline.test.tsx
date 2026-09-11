/**
 * @vitest-environment jsdom
 *
 * Render tests for Version History and the Timeline.
 *
 * History is the undo surface of the whole app: every snapshot listed there is a
 * previous version of a file, and the Restore button overwrites the current one.
 * Two things therefore have to hold — the restore must be confirmed before it
 * runs, and it must reach `restoreSnapshot` with the id of the entry the author
 * actually clicked, followed by the kind-specific refresh that makes the restored
 * content visible again. The preview is the only way to see a snapshot before
 * committing to it, so it must read both the snapshot and the live file.
 *
 * The Timeline is hand-authored world history. It is stored somewhere else
 * entirely, so every create, edit and delete has to be persisted through
 * `saveTimelineEvents` as a whole, correctly ordered list — a list written in the
 * wrong order silently reorders the world's chronology.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { formatTime } from '../../src/renderer/src/lib'
import type { AppConfig, NovelMeta, SnapshotEntry, TimelineEvent } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  readSnapshot: vi.fn(),
  readWorldFile: vi.fn(),
  restoreSnapshot: vi.fn(),
  listSettings: vi.fn(),
  getNovelMeta: vi.fn(),
  readVoiceProfile: vi.fn(),
  listTimelineEvents: vi.fn(),
  saveTimelineEvents: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {}, chatStream: vi.fn() }))

const config: AppConfig = {
  ai: { providers: [], activeProviderId: null },
  personas: [],
  consistency: { providerId: null, systemPrompt: '', userTemplate: '{{material}}' },
  writing: {
    providerId: null,
    outlineSystemPrompt: '',
    rewriteSystemPrompt: '',
    temperature: 0.8,
    topP: 0.9,
  },
}

const novel: NovelMeta = {
  title: 'The Ash Ledger',
  author: 'V.',
  synopsis: '',
  tags: [],
  volumes: [],
}

const NEWER_TS = Date.UTC(2024, 1, 3, 9, 15)
const OLDER_TS = Date.UTC(2023, 6, 11, 18, 42)
const OUTLINE_TS = Date.UTC(2024, 4, 20, 7, 5)

const SNAPSHOT_TEXT = '# Chapter 1: Ash\n\nThe rain fell for a week.'
const LIVE_TEXT = '# Chapter 1: Ash\n\nThe rain never fell at all.'

const CHAPTER_NEWER: SnapshotEntry = {
  id: 'chapters/c1.md/1706951700000.snap',
  sourcePath: 'chapters/c1.md',
  label: 'Chapter 1: Ash',
  kind: 'chapter',
  ts: NEWER_TS,
  size: 2048,
}

const CHAPTER_OLDER: SnapshotEntry = {
  id: 'chapters/c1.md/1689100920000.snap',
  sourcePath: 'chapters/c1.md',
  label: 'Chapter 1: Ash',
  kind: 'chapter',
  ts: OLDER_TS,
  size: 1024,
}

const OUTLINE_SNAPSHOT: SnapshotEntry = {
  id: 'outline.json/1716192300000.snap',
  sourcePath: 'outline.json',
  label: 'Outline',
  kind: 'outline',
  ts: OUTLINE_TS,
  size: 512,
}

/** Returned in a deliberately wrong order so the view's own sorting is what pins it. */
const EVENTS: TimelineEvent[] = [
  {
    id: 'evt_late',
    title: 'The Long Winter',
    dateLabel: 'Year 1240',
    dateOrder: 300,
    description: 'Snow for a decade.',
    docRefs: [],
  },
  {
    id: 'evt_early',
    title: 'The Founding',
    dateLabel: 'Year 12',
    dateOrder: 10,
    description: 'The first stone.',
    docRefs: [],
  },
  {
    id: 'evt_mid',
    title: 'The Sundering',
    dateLabel: 'Year 700',
    dateOrder: 100,
    description: '',
    docRefs: ['01-worldview/rules.md'],
  },
]

const event = (id: string): TimelineEvent => ({ ...EVENTS.find((e) => e.id === id)! })

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  // jsdom's own confirm is a not-implemented stub; every destructive test drives it.
  vi.spyOn(window, 'confirm').mockReturnValue(true)

  api.listSnapshots.mockResolvedValue([])
  api.readSnapshot.mockResolvedValue('')
  api.readWorldFile.mockResolvedValue('')
  api.restoreSnapshot.mockResolvedValue(undefined)
  api.listSettings.mockResolvedValue([])
  api.getNovelMeta.mockResolvedValue(novel)
  api.readVoiceProfile.mockResolvedValue(null)
  api.listTimelineEvents.mockImplementation(async () => EVENTS.map((e) => ({ ...e })))
  api.saveTimelineEvents.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function seedStore(snapshotFocusId: string | null, timelineFocusId: string | null) {
  const { useStore } = await import('../../src/renderer/src/store')
  // Zustand's set merges, so the focus fields are explicitly reset each test.
  useStore.setState({
    novel,
    config,
    settingDocs: [
      { id: '01-worldview/rules.md', title: 'Rules', category: '01-worldview', updatedAt: 1 },
    ],
    worlds: [],
    currentWorldId: 'w1',
    snapshotFocusId,
    timelineFocusId,
  } as never)
  return useStore
}

async function mountHistory(): Promise<void> {
  await seedStore(null, null)
  const mod = await import('../../src/renderer/src/views/History')
  render(<mod.default />)
}

async function mountTimeline(): Promise<void> {
  await seedStore(null, null)
  const mod = await import('../../src/renderer/src/views/Timeline')
  render(<mod.default />)
}

describe('version history', () => {
  it('says there is nothing to restore when no snapshot exists', async () => {
    await mountHistory()

    expect(await screen.findByText('No snapshots yet')).toBeTruthy()
    expect(screen.getByText(/nothing to restore for now/)).toBeTruthy()
    expect(api.listSnapshots).toHaveBeenCalledTimes(1)
  })

  it('groups the snapshots by source file and counts the versions', async () => {
    api.listSnapshots.mockResolvedValue([CHAPTER_NEWER, CHAPTER_OLDER, OUTLINE_SNAPSHOT])
    await mountHistory()

    expect(await screen.findByText('Chapter 1: Ash')).toBeTruthy()
    // Two chapter versions collapsed under one heading, one standalone outline.
    expect(screen.getByText('2 versions')).toBeTruthy()
    expect(screen.getByText('Outline')).toBeTruthy()
    expect(screen.getByText('1 version')).toBeTruthy()
    expect(screen.getAllByText(/^\d+\.\d KB$/)).toHaveLength(3)
  })

  it('confirms before restoring and then restores the clicked version', async () => {
    api.listSnapshots.mockResolvedValue([CHAPTER_NEWER, CHAPTER_OLDER, OUTLINE_SNAPSHOT])
    await mountHistory()
    await screen.findByText('Chapter 1: Ash')

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const restores = screen.getAllByTitle('Restore this version')
    expect(restores).toHaveLength(3)

    // Declining the prompt is the whole safety net: nothing may be overwritten.
    fireEvent.click(restores[1])
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('"Chapter 1: Ash"'))
    expect(api.restoreSnapshot).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    fireEvent.click(restores[1])
    await waitFor(() => expect(api.restoreSnapshot).toHaveBeenCalledWith(CHAPTER_OLDER.id))
    // A restored chapter lives in the novel store, so that store is refreshed and
    // the list is reloaded to reflect what is now on disk.
    await waitFor(() => expect(api.getNovelMeta).toHaveBeenCalled())
    await waitFor(() => expect(api.listSnapshots.mock.calls.length).toBeGreaterThan(1))
    // Only one snapshot was restored.
    expect(api.restoreSnapshot).toHaveBeenCalledTimes(1)
  })

  it('refreshes only what the restored kind affects', async () => {
    api.listSnapshots.mockResolvedValue([OUTLINE_SNAPSHOT])
    await mountHistory()
    await screen.findByText('Outline')

    fireEvent.click(screen.getByTitle('Restore this version'))
    await waitFor(() => expect(api.restoreSnapshot).toHaveBeenCalledWith(OUTLINE_SNAPSHOT.id))

    // An outline restore reloads the outline view on mount and must not tear down
    // the novel or the codex state.
    await waitFor(() => expect(api.listSnapshots.mock.calls.length).toBeGreaterThan(1))
    expect(api.getNovelMeta).not.toHaveBeenCalled()
    expect(api.listSettings).not.toHaveBeenCalled()
  })

  it('reports a restore that failed instead of presenting it as done', async () => {
    api.listSnapshots.mockResolvedValue([CHAPTER_NEWER])
    api.restoreSnapshot.mockRejectedValue(new Error('disk on fire'))
    await mountHistory()
    await screen.findByText('Chapter 1: Ash')

    fireEvent.click(screen.getByTitle('Restore this version'))
    await waitFor(() => expect(api.restoreSnapshot).toHaveBeenCalledWith(CHAPTER_NEWER.id))

    // The failure reaches the author, and the snapshot list is left alone rather
    // than reloaded as if the current version had been replaced.
    const { useToastStore } = await import('../../src/renderer/src/toast')
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.type === 'error' && t.message.includes('disk on fire')),
      ).toBe(true),
    )
    expect(api.listSnapshots).toHaveBeenCalledTimes(1)
  })

  it('previews a snapshot against the live file, in raw and diff form', async () => {
    api.listSnapshots.mockResolvedValue([CHAPTER_NEWER])
    api.readSnapshot.mockResolvedValue(SNAPSHOT_TEXT)
    api.readWorldFile.mockResolvedValue(LIVE_TEXT)
    await mountHistory()

    fireEvent.click(await screen.findByText(formatTime(NEWER_TS)))
    await waitFor(() => expect(api.readSnapshot).toHaveBeenCalledWith(CHAPTER_NEWER.id))
    // The diff needs the current file too, so both are read together.
    expect(api.readWorldFile).toHaveBeenCalledWith(CHAPTER_NEWER.sourcePath)
    expect(await screen.findByText(/The rain fell for a week/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(await screen.findByText(/Red = current version/)).toBeTruthy()
    // The comparison is read-only: there is nothing to accept or discard.
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
  })

  it('opens the snapshot the store asked it to focus and clears that focus', async () => {
    api.listSnapshots.mockResolvedValue([CHAPTER_NEWER, CHAPTER_OLDER])
    api.readSnapshot.mockResolvedValue(SNAPSHOT_TEXT)
    api.readWorldFile.mockResolvedValue(LIVE_TEXT)
    const useStore = await seedStore(CHAPTER_OLDER.id, null)

    const mod = await import('../../src/renderer/src/views/History')
    render(<mod.default />)

    await waitFor(() => expect(api.readSnapshot).toHaveBeenCalledWith(CHAPTER_OLDER.id))
    expect(await screen.findByText(/The rain fell for a week/)).toBeTruthy()
    // The focus is consumed, so returning to the view does not reopen the preview.
    expect(useStore.getState().snapshotFocusId).toBeNull()
  })
})

describe('the timeline', () => {
  it('invites the author to start when there is no event yet', async () => {
    api.listTimelineEvents.mockResolvedValue([])
    await mountTimeline()

    expect(await screen.findByText(/No timeline events yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /add event/i })).toBeTruthy()
  })

  it('lists the authored events in chronological order', async () => {
    await mountTimeline()

    await screen.findByText('The Long Winter')
    const rendered = document.body.textContent ?? ''
    // The stored order is arbitrary; the numeric sort key decides what is shown.
    expect(rendered.indexOf('The Founding')).toBeLessThan(rendered.indexOf('The Sundering'))
    expect(rendered.indexOf('The Sundering')).toBeLessThan(rendered.indexOf('The Long Winter'))
    expect(screen.getByText('Year 12')).toBeTruthy()
    expect(api.listTimelineEvents).toHaveBeenCalledTimes(1)
  })

  it('adds an event, parsing its sort key and keeping the list ordered', async () => {
    api.listTimelineEvents.mockResolvedValue([event('evt_mid')])
    await mountTimeline()
    await screen.findByText('The Sundering')

    fireEvent.click(screen.getByRole('button', { name: /add event/i }))
    fireEvent.change(screen.getByPlaceholderText('Event title'), {
      target: { value: '  The Founding  ' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Date label/), {
      target: { value: ' Year 12 ' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Sort order/), { target: { value: '10' } })
    fireEvent.change(screen.getByPlaceholderText(/Description/), {
      target: { value: 'The first stone.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(api.saveTimelineEvents).toHaveBeenCalled())
    const [written] = api.saveTimelineEvents.mock.calls.at(-1)!
    expect(written).toHaveLength(2)
    // Padding is trimmed, the order field is a number, and the new earlier event
    // is written before the existing later one.
    expect(written[0]).toMatchObject({
      title: 'The Founding',
      dateLabel: 'Year 12',
      dateOrder: 10,
      description: 'The first stone.',
      docRefs: [],
    })
    expect(written[0].id).toMatch(/^evt_/)
    expect(written[1]).toMatchObject({ id: 'evt_mid', dateOrder: 100 })

    // The form closes once the event is stored.
    await waitFor(() => expect(screen.queryByPlaceholderText('Event title')).toBeNull())
  })

  it('saves an edited event with its changed fields on the same id', async () => {
    api.listTimelineEvents.mockResolvedValue([event('evt_mid')])
    await mountTimeline()
    await screen.findByText('The Sundering')

    fireEvent.click(screen.getByTitle('Edit event'))
    fireEvent.change(await screen.findByDisplayValue('The Sundering'), {
      target: { value: 'The Sundering of Ash' },
    })
    fireEvent.change(screen.getByDisplayValue('Year 700'), { target: { value: 'Year 705' } })
    fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(api.saveTimelineEvents).toHaveBeenCalled())
    const [written] = api.saveTimelineEvents.mock.calls.at(-1)!
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      id: 'evt_mid',
      title: 'The Sundering of Ash',
      dateLabel: 'Year 705',
      dateOrder: 150,
      // Unchanged fields, including the codex links, survive the edit.
      description: '',
      docRefs: ['01-worldview/rules.md'],
    })
  })

  it('deletes an event only after the author confirms', async () => {
    api.listTimelineEvents.mockResolvedValue([event('evt_mid')])
    await mountTimeline()
    await screen.findByText('The Sundering')

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByTitle('Delete event'))
    expect(confirmSpy).toHaveBeenCalledWith('Delete "The Sundering"?')
    expect(api.saveTimelineEvents).not.toHaveBeenCalled()
    expect(screen.getByText('The Sundering')).toBeTruthy()

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByTitle('Delete event'))
    await waitFor(() => expect(api.saveTimelineEvents).toHaveBeenCalled())
    expect(api.saveTimelineEvents.mock.calls.at(-1)![0]).toEqual([])
    expect(await screen.findByText(/No timeline events yet/)).toBeTruthy()
  })

  it('scrolls to the event the store asked it to focus and clears that focus', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const useStore = await seedStore(null, 'evt_mid')

    const mod = await import('../../src/renderer/src/views/Timeline')
    render(<mod.default />)

    await screen.findByText('The Sundering')
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled())
    // The focused event is the one that gets highlighted.
    expect(screen.getByText('The Sundering').closest('.card')?.className).toContain(
      'ring-star-accent',
    )
    expect(useStore.getState().timelineFocusId).toBeNull()
  })
})
