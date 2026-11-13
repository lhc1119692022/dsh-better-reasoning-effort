import { createElement, useMemo, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { FAST_CHANNEL } from '../constants.js'

type FastStatus = {
  enabled: boolean
  supported: boolean
  active: boolean
  provider: string | null
  model: string | null
  serviceTier: 'priority'
  reason: string | null
}
type Snapshot = { value: FastStatus | null; pending: boolean; error: string | null }
export type FastConnection = {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
  generation?: { subscribe(listener: () => void): () => void }
}
type StateResult = { ok: true; value: FastStatus } | { ok: false; error?: { message?: string } }

function createStateSource(connection: FastConnection, sessionId: string) {
  let snapshot: Snapshot = { value: null, pending: false, error: null }
  let sequence = 0
  let request: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopGeneration: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: Snapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (listeners.size) timer = setTimeout(() => { void refresh() }, 2_000)
  }
  async function call(enabled?: boolean): Promise<void> {
    const ticket = ++sequence
    request?.abort()
    request = new AbortController()
    if (timer !== undefined) clearTimeout(timer)
    const changing = enabled !== undefined
    if (changing) publish({ ...snapshot, pending: true, error: null })
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
      const result = await connection.rpc.call(FAST_CHANNEL, 'state',
        { sessionId, ...(changing ? { enabled } : {}) }, signal) as StateResult
      if (ticket !== sequence) return
      if (!result?.ok) throw new Error(result?.error?.message ?? 'Fast state unavailable')
      publish({ value: result.value, pending: false, error: null })
    } catch (error) {
      if (ticket !== sequence) return
      publish({ ...snapshot, pending: false, error: error instanceof Error ? error.message : 'Fast state unavailable' })
    } finally {
      if (ticket === sequence) schedule()
    }
  }
  function refresh(): void {
    if (!snapshot.pending) void call()
  }
  function reset(): void {
    ++sequence
    request?.abort()
    publish({ value: null, pending: false, error: null })
    refresh()
  }
  return {
    getSnapshot: (): Snapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopGeneration = connection.generation?.subscribe(reset)
        refresh()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          ++sequence
          request?.abort()
          if (timer !== undefined) clearTimeout(timer)
          stopGeneration?.()
          stopGeneration = undefined
          snapshot = { value: null, pending: false, error: null }
        }
      }
    },
    toggle(): void {
      if (!snapshot.pending) void call(!snapshot.value?.enabled)
    },
  }
}

function hasGptModel(model: unknown): boolean {
  return typeof model === 'string' && model.toLowerCase().includes('gpt')
}

export function FastButton({ sessionId, connection, t }: {
  sessionId?: string
  connection: FastConnection
  t: (key: string) => string
}): ReactElement | null {
  const source = useMemo(() => sessionId ? createStateSource(connection, sessionId) : null, [connection, sessionId])
  const empty = useMemo(() => ({ getSnapshot: () => ({ value: null, pending: false, error: null }), subscribe: () => () => {} }), [])
  const stateSource = source ?? empty
  const { value, pending, error } = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot, stateSource.getSnapshot)
  if (!sessionId) return null
  if (!value) {
    return error
      ? createElement('span', { className: 'bre-fast-status', role: 'status', 'aria-live': 'polite', title: error }, t('fastUnavailable'))
      : null
  }
  if (!hasGptModel(value.model)) return null

  const active = value.active
  const paused = value.enabled && !active
  const unsupported = !value.supported && !paused
  const title = error ?? value.reason ?? (active ? t('fastActiveTitle') : t('fastInactiveTitle'))
  return createElement('button', {
    type: 'button',
    className: 'bre-fast-button',
    disabled: pending || unsupported,
    'data-active': String(active),
    'aria-pressed': value.enabled,
    'aria-busy': pending,
    'aria-label': active ? t('fastAriaOn') : paused ? t('fastAriaPaused') : t('fastAriaOff'),
    title,
    onClick: () => source?.toggle(),
  },
  createElement('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  createElement('path', { d: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z' })),
  pending ? 'Fast …' : active ? t('fastOn') : paused ? t('fastPaused') : 'Fast')
}
