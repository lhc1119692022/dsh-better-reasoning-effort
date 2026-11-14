/**
 * Optional GPT Fast bridge: adds `service_tier: "priority"` to the outgoing
 * Responses payload of sessions that turned Fast on.
 *
 * It wraps the LIVE pi-ai adapter's `streamWithSnapshot` (found from the
 * adapter instance the Host's `llm` service holds, never from a module copy
 * this package might resolve on its own), and only ever touches a request when
 * every gate holds: a main-loop request (no `purpose`), with a session id, on
 * a GPT model whose configured descriptor speaks `openai-responses`, for a
 * session whose Fast flag is on. Everything else passes through untouched, and
 * any failure inside the gate falls back to the original call.
 *
 * @module dsh-better-reasoning-effort/fast-mode/bridge
 */

const OWNER = Symbol.for('dsh-better-reasoning-effort.fast-bridge')
/** The only wire protocol whose payload accepts `service_tier`. */
export const FAST_API = 'openai-responses'

export interface FastRequest {
  provider: string
  model: string
  sessionId?: unknown
  purpose?: unknown
  [key: string]: unknown
}

interface ModelDescriptor { api?: unknown }
interface PiModels {
  streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown
}
interface PiSnapshot {
  models: PiModels
  [key: string]: unknown
}
/** The adapter members the bridge relies on (private in TS, present at runtime). */
interface AdapterSurface {
  current(): PiSnapshot
  modelOf(snapshot: PiSnapshot, provider: string, model: string): ModelDescriptor
  streamWithSnapshot(options: FastRequest, snapshot: PiSnapshot): AsyncIterable<unknown>
}

/** Bridge handle. */
export interface FastBridge {
  /** The prototype carrying the wrap. */
  readonly target: object
  /** Restore the original method (keeps a later wrapper from another plugin). */
  dispose(): void
}

/**
 * Whether a provider-owned model id names a GPT model: the last path segment
 * starts with `gpt-` (or is exactly `gpt`). `mc-gpt/gpt-6.1-sol` matches,
 * `yf/deepseek-v4.1-flash` and `mc-gpt/claude-x` do not.
 */
export function isGptModel(model: unknown): model is string {
  if (typeof model !== 'string' || model.length === 0) return false
  const leaf = model.split('/').at(-1) ?? ''
  return /^gpt(?:-|$)/i.test(leaf)
}

/** Whether a configured model descriptor can carry the priority tier. */
export function descriptorSupportsFast(model: unknown, descriptor: ModelDescriptor | undefined): boolean {
  return isGptModel(model) && descriptor?.api === FAST_API
}

/**
 * The prototype that OWNS the adapter's stream entry, walking up from an
 * instance. Returns undefined when the instance is not a pi-ai-shaped adapter.
 */
export function adapterPrototypeOf(adapter: unknown): object | undefined {
  if (typeof adapter !== 'object' || adapter === null) return undefined
  let proto: object | null = Object.getPrototypeOf(adapter) as object | null
  while (proto !== null && proto !== Object.prototype) {
    const own = Object.getOwnPropertyDescriptor(proto, 'streamWithSnapshot')
    if (own !== undefined && typeof own.value === 'function') {
      const surface = proto as Record<string, unknown>
      return typeof surface['modelOf'] === 'function' && typeof surface['current'] === 'function'
        ? proto
        : undefined
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return undefined
}

function withPriority(options: Record<string, unknown> = {}): Record<string, unknown> {
  const previous = options['onPayload']
  return {
    ...options,
    serviceTier: 'priority',
    async onPayload(payload: unknown, model: unknown): Promise<unknown> {
      // Respect a callback that returned a new body; undefined keeps the original.
      const transformed = typeof previous === 'function'
        ? await (previous as (payload: unknown, model: unknown) => unknown)(payload, model)
        : undefined
      const body = transformed ?? payload
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
      return { ...(body as Record<string, unknown>), service_tier: 'priority' }
    },
  }
}

/**
 * Wrap one adapter prototype. A wrap left by an earlier load of this plugin
 * (HMR, disable/enable) is released first, so the process never stacks two.
 * @param proto - the prototype owning `streamWithSnapshot` ({@link adapterPrototypeOf}).
 * @param isEnabled - whether a session id has Fast on.
 */
export function installFastBridge(proto: object, isEnabled: (sessionId: string) => boolean): FastBridge {
  const surface = proto as Record<PropertyKey, unknown>
  const previous = surface[OWNER] as FastBridge | undefined
  if (previous !== undefined) previous.dispose()

  const originalStream = surface['streamWithSnapshot']
  if (typeof originalStream !== 'function' || typeof surface['modelOf'] !== 'function') {
    throw new Error('incompatible pi-ai adapter: streamWithSnapshot/modelOf missing')
  }
  const original = originalStream as AdapterSurface['streamWithSnapshot']
  let active = true

  const shouldInject = (adapter: AdapterSurface, request: FastRequest, snapshot: PiSnapshot): boolean => {
    if (!active || request.purpose !== undefined || request.sessionId === undefined) return false
    if (!isGptModel(request.model)) return false
    if (!isEnabled(String(request.sessionId))) return false
    return descriptorSupportsFast(request.model, adapter.modelOf(snapshot, request.provider, request.model))
  }

  const wrapped = function (this: AdapterSurface, request: FastRequest, snapshot: PiSnapshot): AsyncIterable<unknown> {
    let inject = false
    try {
      inject = shouldInject(this, request, snapshot)
    } catch {
      // Unknown route/model or a shape change: never block the original call.
      inject = false
    }
    if (!inject) return original.call(this, request, snapshot)
    const models = new Proxy(snapshot.models, {
      get(target, key) {
        if (key === 'streamSimple') {
          return (model: unknown, context: unknown, callOptions?: Record<string, unknown>) =>
            target.streamSimple(model, context, withPriority(callOptions))
        }
        const value = Reflect.get(target, key, target) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    return original.call(this, request, { ...snapshot, models })
  }

  const bridge: FastBridge = {
    target: proto,
    dispose(): void {
      if (!active) return
      active = false
      if (surface['streamWithSnapshot'] === wrapped) surface['streamWithSnapshot'] = original
      if (surface[OWNER] === bridge) delete surface[OWNER]
    },
  }
  surface['streamWithSnapshot'] = wrapped
  surface[OWNER] = bridge
  return bridge
}
