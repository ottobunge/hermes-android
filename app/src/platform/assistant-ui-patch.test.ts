// Pins patches/@assistant-ui+core+0.2.23.patch (applied by `postinstall`):
// LazyMemoizeSubject must hand back a stable snapshot while nothing changed,
// even with no subscriber — ThreadListRuntimeImpl never connects it, and a
// fresh object per read drove tap's useSyncExternalStore into "Maximum update
// depth exceeded … getSnapshot should be cached" on every connected page.
import { LazyMemoizeSubject } from '@assistant-ui/core/internal'
import { describe, expect, it } from 'vitest'

function threadListLike() {
  const store = { mainThreadId: 'a', threadIds: ['a'] as readonly string[] }
  const listeners = new Set<() => void>()

  const subject = new LazyMemoizeSubject({
    path: {},
    // Same shape as getThreadListState(): a NEW wrapper object every call.
    getState: () => ({ mainThreadId: store.mainThreadId, threadIds: store.threadIds }),
    subscribe: (callback: () => void) => {
      listeners.add(callback)

      return () => listeners.delete(callback)
    }
  })

  const change = (next: Partial<typeof store>) => {
    Object.assign(store, next)
    listeners.forEach(callback => callback())
  }

  return { subject, change }
}

describe('assistant-ui LazyMemoizeSubject patch', () => {
  it('returns the same snapshot for unchanged state while disconnected', () => {
    // No subscribe() call: the subject stays disconnected, as in ThreadListRuntimeImpl.
    const { subject } = threadListLike()

    expect(subject.getState()).toBe(subject.getState())
  })

  it('still hands out a new snapshot when a field changes (disconnected and connected)', () => {
    const { subject, change } = threadListLike()
    const first = subject.getState()

    change({ mainThreadId: 'b', threadIds: ['a', 'b'] })
    const second = subject.getState()
    expect(second).not.toBe(first)
    expect(second).toEqual({ mainThreadId: 'b', threadIds: ['a', 'b'] })

    const unsubscribe = subject.subscribe(() => {})
    change({ mainThreadId: 'a' })
    expect(subject.getState()).toEqual({ mainThreadId: 'a', threadIds: ['a', 'b'] })
    change({})
    const settled = subject.getState()
    expect(subject.getState()).toBe(settled)
    unsubscribe()
  })
})
