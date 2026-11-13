import { describe, expect, it, vi } from 'vitest'
import { installFastBridge, isGptModel } from '../src/fast-mode/bridge.js'
import type { FastRequest } from '../src/fast-mode/bridge.js'
import { createFastController, FAST_CHANNEL } from '../src/fast-mode/controller.js'

type TestSnapshot = { models: { streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => Promise<unknown> } }
type TestAdapterSurface = {
  prepareCall(provider: string, model: string): unknown
  streamWithSnapshot(request: FastRequest, snapshot: TestSnapshot): AsyncIterable<unknown>
}

const fastRequest = {
  provider: 'magpie-responses',
  model: 'mca-gpt/gpt-6.1-sol',
  sessionId: 'session-1',
}

describe('Fast adapter bridge', () => {
  it('adds only service_tier and preserves an existing payload callback', async () => {
    const model = { api: 'openai-responses' }
    const snapshot: TestSnapshot = {
      models: {
        streamSimple: vi.fn(async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
          const onPayload = options?.['onPayload'] as (payload: unknown, model: unknown) => Promise<unknown>
          return onPayload({ input: 'kept', service_tier: 'auto' }, model)
        }),
      },
    }
    class Adapter {}
    Object.assign(Adapter.prototype, {
      current: () => snapshot,
      modelOf: () => model,
      prepareCall: () => Promise.resolve(),
      streamWithSnapshot: function (this: { modelOf: () => unknown }, request: FastRequest, callSnapshot: TestSnapshot) {
        const adapter = this as unknown as { modelOf: () => unknown }
        const descriptor = adapter.modelOf()
        const callOptions = { onPayload: (payload: Record<string, unknown>) => ({ ...payload, existing: true }) }
        return (async function* () {
          yield await callSnapshot.models.streamSimple(descriptor, {}, callOptions)
        })()
      },
    })
    const originalStream = (Adapter.prototype as unknown as Record<string, unknown>)['streamWithSnapshot']
    const bridge = installFastBridge(Adapter as unknown as { prototype: object }, { isEnabled: id => id === 'session-1' })
    try {
      const adapter = new Adapter() as unknown as TestAdapterSurface
      const capability = await bridge.probe(() => adapter.prepareCall('magpie-responses', 'mca-gpt/gpt-6.1-sol'))
      expect(capability).toEqual({ supported: true, api: 'openai-responses' })
      const chunks: unknown[] = []
      for await (const chunk of adapter.streamWithSnapshot(fastRequest, snapshot)) chunks.push(chunk)
      expect(chunks).toEqual([{ input: 'kept', service_tier: 'priority', existing: true }])
      expect(snapshot.models.streamSimple).toHaveBeenCalledWith(model, expect.anything(), expect.objectContaining({ serviceTier: 'priority' }))
    } finally {
      bridge.dispose()
      expect((Adapter.prototype as unknown as Record<string, unknown>)['streamWithSnapshot']).toBe(originalStream)
    }
  })

  it('does not wrap non-GPT, other-provider, or purpose requests', async () => {
    expect(isGptModel('openai/GPT-6')).toBe(true)
    expect(isGptModel('claude-sonnet')).toBe(false)
    const model = { api: 'openai-responses' }
    const snapshot: TestSnapshot = {
      models: {
        streamSimple: vi.fn(async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
          const callback = options?.['onPayload'] as (payload: unknown) => unknown
          return callback({ original: true })
        }),
      },
    }
    class Adapter {}
    Object.assign(Adapter.prototype, {
      current: () => snapshot,
      modelOf: () => model,
      prepareCall: () => Promise.resolve(),
      streamWithSnapshot: function (this: { modelOf: () => unknown }, request: FastRequest, callSnapshot: TestSnapshot) {
        const originalOptions = { onPayload: (payload: unknown) => payload }
        const adapter = this
        return (async function* () {
          yield await callSnapshot.models.streamSimple(adapter.modelOf(), {}, originalOptions)
        })()
      },
    })
    const bridge = installFastBridge(Adapter as unknown as { prototype: object }, { isEnabled: () => true })
    try {
      const adapter = new Adapter() as unknown as TestAdapterSurface
      const requests: FastRequest[] = [
        { ...fastRequest, model: 'claude-sonnet' },
        { ...fastRequest, provider: 'openai' },
        { ...fastRequest, purpose: 'title' },
      ]
      for (const request of requests) {
        const result: unknown[] = []
        for await (const value of adapter.streamWithSnapshot(request, snapshot)) result.push(value)
        expect(result).toEqual([{ original: true }])
      }
      expect(snapshot.models.streamSimple).toHaveBeenCalledTimes(3)
    } finally {
      bridge.dispose()
    }
  })
})

describe('Fast session controller', () => {
  it('uses a Host-valid single-segment Connection channel', () => {
    expect(FAST_CHANNEL).toMatch(/^\/[A-Za-z0-9._~-]+$/)
  })

  it('keeps Fast state per session and pauses it outside the supported GPT route', async () => {
    const session = {}
    let selection = { provider: 'magpie-responses', model: 'mca-gpt/gpt-6.1-sol' }
    const ctx = {
      agents: { get: (id: string) => id === 'session-1' ? { session } : undefined },
      sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: selection } } }) },
      agentDefaultModel: { currentSelection: () => selection },
      llm: { prepareCall: vi.fn(async () => undefined) },
      connection: { rpc: { handle: vi.fn() } },
    }
    const probe = vi.fn(async () => ({ supported: true, api: 'openai-responses' }))
    const controller = createFastController(ctx, probe)
    const read = await controller.handle('state', { sessionId: 'session-1' }) as { ok: true; value: { supported: boolean; enabled: boolean } }
    expect(read.value.supported).toBe(true)
    expect(read.value.enabled).toBe(false)

    const enabled = await controller.handle('state', { sessionId: 'session-1', enabled: true }) as { ok: true; value: { active: boolean } }
    expect(enabled.value.active).toBe(true)
    expect(controller.isEnabled('session-1')).toBe(true)
    expect(controller.isEnabled('another-session')).toBe(false)

    selection = { provider: 'magpie-responses', model: 'claude-sonnet' }
    const paused = await controller.handle('state', { sessionId: 'session-1' }) as { ok: true; value: { enabled: boolean; active: boolean; supported: boolean } }
    expect(paused.value).toMatchObject({ enabled: true, active: false, supported: false })
    await controller.handle('state', { sessionId: 'session-1', enabled: false })
    expect(controller.isEnabled('session-1')).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported routes and malformed input', async () => {
    const session = {}
    const ctx = {
      agents: { get: (id: string) => id === 's' ? { session } : undefined },
      sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: { provider: 'other', model: 'gpt-model' } } } }) },
      agentDefaultModel: { currentSelection: () => undefined },
      llm: { prepareCall: vi.fn() },
      connection: { rpc: { handle: vi.fn() } },
    }
    const controller = createFastController(ctx, async () => ({ supported: false, api: null }))
    const invalid = await controller.handle('state', { sessionId: 's', enabled: 'yes' }) as { ok: boolean }
    const unsupported = await controller.handle('state', { sessionId: 's', enabled: true }) as { ok: boolean; error?: { code?: string } }
    expect(invalid.ok).toBe(false)
    expect(unsupported.error?.code).toBe('FAST_UNAVAILABLE')
    expect(probeNotCalled(ctx.llm.prepareCall)).toBe(true)
  })
})

function probeNotCalled(mock: ReturnType<typeof vi.fn>): boolean {
  return mock.mock.calls.length === 0
}
