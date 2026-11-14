/**
 * Per-session GPT Fast state and the status the composer button renders.
 *
 * Support is decided from the LIVE pi-ai adapter the Host's `llm` service
 * holds for the requested route: the configured model descriptor's protocol
 * and the GPT model id. That read is synchronous and side-effect free (no
 * credential, no network). The first supported read installs the bridge on
 * that adapter's prototype; the request gate itself lives in the bridge.
 *
 * State is process-local: a Host restart turns every session's Fast off.
 *
 * @module dsh-better-reasoning-effort/fast-mode/controller
 */
import { adapterPrototypeOf, descriptorSupportsFast, installFastBridge, isGptModel, type FastBridge } from './bridge.js'

/** Upper bound of remembered sessions; the oldest flag is evicted first. */
const MAX_SESSIONS = 1000

/** What the controller needs from the Host, read lazily on every request. */
export type LlmLookup = () => unknown

/** Body of the status route. */
export interface FastStatus {
  /** The session's Fast flag. */
  enabled: boolean
  /** Whether the requested route/model can carry the priority tier. */
  supported: boolean
  /** Fast is applied to this route's next requests. */
  active: boolean
}

export type FastResult =
  | { ok: true; value: FastStatus }
  | { ok: false; error: { code: 'INVALID_ARGUMENT' | 'UNSUPPORTED' | 'UNAVAILABLE' } }

interface StateInput {
  sessionId: string
  provider: string
  model: string
  enabled?: boolean
}

interface AdapterLike {
  current(): unknown
  modelOf(snapshot: unknown, provider: string, model: string): { api?: unknown }
}

function parseInput(input: unknown): StateInput | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const field = value[key]
    return typeof field === 'string' && field.length > 0 && field.length <= 256 ? field : undefined
  }
  const sessionId = text('sessionId')
  const provider = text('provider')
  const model = text('model')
  if (sessionId === undefined || provider === undefined || model === undefined) return undefined
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') return undefined
  return { sessionId, provider, model, ...(typeof value['enabled'] === 'boolean' ? { enabled: value['enabled'] } : {}) }
}

/** The adapter instance registered for a provider route, or undefined. */
export function adapterFor(llm: unknown, provider: string): unknown {
  if (typeof llm !== 'object' || llm === null) return undefined
  const registry = (llm as { adapters?: unknown }).adapters
  if (!(registry instanceof Map)) return undefined
  const registration = Map.prototype.get.call(registry, provider) as { adapter?: unknown } | undefined
  return registration?.adapter
}

/**
 * Build the controller.
 * @param getLlm - lazy read of the Host's `llm` service (undefined while it is absent).
 * @param warn - one-line diagnostic sink.
 */
export function createFastController(getLlm: LlmLookup, warn: (message: string) => void = () => {}) {
  const enabledSessions = new Set<string>()
  let bridge: FastBridge | undefined
  let disposed = false

  const isEnabled = (sessionId: string): boolean => enabledSessions.has(sessionId)

  const ensureBridge = (adapter: unknown): void => {
    if (disposed) return
    const proto = adapterPrototypeOf(adapter)
    if (proto === undefined || bridge?.target === proto) return
    try {
      bridge?.dispose()
      bridge = installFastBridge(proto, isEnabled)
    } catch (error) {
      bridge = undefined
      warn(`Fast bridge unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Whether the route can carry Fast; installs the bridge on the first yes. */
  const supportOf = (provider: string, model: string): boolean => {
    if (!isGptModel(model)) return false
    const adapter = adapterFor(getLlm(), provider) as AdapterLike | undefined
    if (adapter === undefined || typeof adapter.current !== 'function' || typeof adapter.modelOf !== 'function') return false
    let supported: boolean
    try {
      supported = descriptorSupportsFast(model, adapter.modelOf(adapter.current(), provider, model))
    } catch {
      return false
    }
    if (supported) ensureBridge(adapter)
    return supported && bridge !== undefined
  }

  const remember = (sessionId: string, enabled: boolean): void => {
    enabledSessions.delete(sessionId)
    if (!enabled) return
    enabledSessions.add(sessionId)
    while (enabledSessions.size > MAX_SESSIONS) {
      const oldest = enabledSessions.values().next().value
      if (oldest === undefined) break
      enabledSessions.delete(oldest)
    }
  }

  function handle(input: unknown): FastResult {
    const request = parseInput(input)
    if (request === undefined) return { ok: false, error: { code: 'INVALID_ARGUMENT' } }
    let supported: boolean
    try {
      supported = supportOf(request.provider, request.model)
    } catch {
      return { ok: false, error: { code: 'UNAVAILABLE' } }
    }
    if (request.enabled === true && !supported) return { ok: false, error: { code: 'UNSUPPORTED' } }
    if (request.enabled !== undefined) remember(request.sessionId, request.enabled)
    const enabled = isEnabled(request.sessionId)
    return { ok: true, value: { enabled, supported, active: enabled && supported } }
  }

  return {
    handle,
    isEnabled,
    dispose(): void {
      disposed = true
      bridge?.dispose()
      bridge = undefined
      enabledSessions.clear()
    },
  }
}
