/** Share the Host-confirmed Fast state between the menu toggle and model label. */
import type { FastStatus } from './FastButton.js'

const values = new Map<string, FastStatus>()
const revisions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

export function fastKey(sessionId: string, provider: string, model: string): string {
  return `${sessionId}\u0000${provider}\u0000${model}`
}

export function fastSnapshot(key: string): FastStatus | undefined { return values.get(key) }
export function fastRevision(key: string): number { return revisions.get(key) ?? 0 }

export function subscribeFast(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (set === undefined) { set = new Set(); listeners.set(key, set) }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(key)
  }
}

export function publishFast(key: string, value: FastStatus | undefined): void {
  revisions.set(key, fastRevision(key) + 1)
  if (value === undefined) values.delete(key)
  else values.set(key, value)
  for (const listener of listeners.get(key) ?? []) listener()
}
