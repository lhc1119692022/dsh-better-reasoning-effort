import { AsyncLocalStorage } from 'node:async_hooks'
const OWNER = Symbol.for('dsh-better-reasoning-effort.fast-bridge')
const FAST_PROVIDER = 'magpie-responses'
const FAST_API = 'openai-responses'

export interface FastCapability {
  supported: boolean
  api: string | null
}

export interface FastRequest {
  provider: string
  model: string
  sessionId?: string
  purpose?: string
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
interface AdapterSurface {
  current(): PiSnapshot
  modelOf(snapshot: PiSnapshot, provider: string, model: string): ModelDescriptor
  prepareCall(provider: string, model: string, signal?: AbortSignal): unknown
  streamWithSnapshot(options: FastRequest, snapshot: PiSnapshot): AsyncIterable<unknown>
}
interface ProbeState extends FastCapability {}

export function isGptModel(model: unknown): model is string {
  return typeof model === 'string' && model.toLowerCase().includes('gpt')
}

function canInject(provider: string, model: ModelDescriptor): boolean {
  return provider === FAST_PROVIDER && model.api === FAST_API
}

function withPriority(options: Record<string, unknown> = {}): Record<string, unknown> {
  const previous = options['onPayload']
  return {
    ...options,
    serviceTier: 'priority',
    async onPayload(payload: unknown, model: unknown): Promise<Record<string, unknown>> {
      const transformed = typeof previous === 'function'
        ? await (previous as (payload: unknown, model: unknown) => unknown)(payload, model)
        : undefined
      const body = transformed ?? payload
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error('dsh-better-reasoning-effort: invalid OpenAI payload')
      }
      return { ...(body as Record<string, unknown>), service_tier: 'priority' }
    },
  }
}

/** Installs a narrow bridge into the verified DSH pi-ai adapter. */
export function installFastBridge(Adapter: { prototype: object }, options: { isEnabled: (sessionId: string) => boolean }) {
  const proto = Adapter.prototype as unknown as Record<PropertyKey, unknown>
  const originalStream = proto['streamWithSnapshot']
  const originalPrepare = proto['prepareCall']
  if (typeof originalStream !== 'function' || typeof originalPrepare !== 'function'
    || typeof proto['modelOf'] !== 'function' || typeof proto['current'] !== 'function') {
    throw new Error('Incompatible PiAiAdapter Fast bridge contract')
  }
  if (proto[OWNER] !== undefined) throw new Error('Fast bridge already installed')

  const probes = new AsyncLocalStorage<ProbeState>()
  let active = true

  const wrappedPrepare = function (this: AdapterSurface, provider: string, model: string, signal?: AbortSignal): unknown {
    const probe = active ? probes.getStore() : undefined
    if (probe) {
      try {
        const descriptor = this.modelOf(this.current(), provider, model)
        probe.api = typeof descriptor.api === 'string' ? descriptor.api : null
        probe.supported = isGptModel(model) && canInject(provider, descriptor)
      } catch {
        probe.supported = false
      }
    }
    return (originalPrepare as AdapterSurface['prepareCall']).call(this, provider, model, signal)
  }

  const wrappedStream = function (this: AdapterSurface, request: FastRequest, snapshot: PiSnapshot): AsyncIterable<unknown> {
    if (!active || request.purpose || !request.sessionId || !isGptModel(request.model)
      || request.provider !== FAST_PROVIDER || !options.isEnabled(String(request.sessionId))) {
      return (originalStream as AdapterSurface['streamWithSnapshot']).call(this, request, snapshot)
    }
    const descriptor = this.modelOf(snapshot, request.provider, request.model)
    if (!canInject(request.provider, descriptor)) {
      return (originalStream as AdapterSurface['streamWithSnapshot']).call(this, request, snapshot)
    }
    const models = new Proxy(snapshot.models, {
      get(target, key) {
        if (key === 'streamSimple') {
          return (model: unknown, context: unknown, callOptions?: Record<string, unknown>) =>
            target.streamSimple(model, context, withPriority(callOptions))
        }
        const value = Reflect.get(target, key, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return (originalStream as AdapterSurface['streamWithSnapshot']).call(this, request, { ...snapshot, models })
  }

  const marker = {}
  proto[OWNER] = marker
  proto['prepareCall'] = wrappedPrepare
  proto['streamWithSnapshot'] = wrappedStream

  return {
    async probe(resolve: () => unknown): Promise<FastCapability> {
      const result: ProbeState = { supported: false, api: null }
      try {
        await probes.run(result, resolve)
      } catch {
        // The controller returns the safe unavailable state to the client.
      }
      return result
    },
    dispose(): void {
      active = false
      if (proto['streamWithSnapshot'] === wrappedStream) proto['streamWithSnapshot'] = originalStream
      if (proto['prepareCall'] === wrappedPrepare) proto['prepareCall'] = originalPrepare
      if (proto[OWNER] === marker) delete proto[OWNER]
    },
  }
}
