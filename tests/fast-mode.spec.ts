import { describe, expect, it, vi } from 'vitest'
import { adapterPrototypeOf, installFastBridge, isGptModel } from '../src/fast-mode/bridge.js'
import type { FastRequest } from '../src/fast-mode/bridge.js'
import { createFastController } from '../src/fast-mode/controller.js'
import { FAST_STATE_PATH } from '../src/constants.js'

type StreamOptions = Record<string, unknown>
type TestSnapshot = { models: { streamSimple: (model: unknown, context: unknown, options?: StreamOptions) => Promise<unknown> } }

/** A pi-ai-shaped adapter: private members at runtime, the stream on the prototype. */
function makeAdapterClass(api: string) {
  const snapshot: TestSnapshot = {
    models: {
      streamSimple: vi.fn(async (_model: unknown, _context: unknown, options?: StreamOptions) => {
        const onPayload = options?.['onPayload'] as (payload: unknown, model: unknown) => Promise<unknown>
        return onPayload({ input: 'kept', service_tier: 'auto' }, {})
      }),
    },
  }
  class Base {}
  class Adapter extends Base {
    current(): TestSnapshot { return snapshot }
    modelOf(_snapshot: unknown, provider: string, model: string): { api: string } {
      if (provider === 'missing') throw new Error(`no model ${model}`)
      return { api }
    }
    streamWithSnapshot(_request: FastRequest, callSnapshot: TestSnapshot): AsyncIterable<unknown> {
      const callOptions = { onPayload: (payload: Record<string, unknown>) => ({ ...payload, existing: true }) }
      return (async function* () {
        yield await callSnapshot.models.streamSimple({}, {}, callOptions)
      })()
    }
  }
  return { Adapter, snapshot }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const request: FastRequest = { provider: 'magpie-responses', model: 'mc-gpt/gpt-6.1-sol', sessionId: 'session-1' }

describe('GPT model matching', () => {
  it('matches the GPT leaf only', () => {
    expect(isGptModel('mc-gpt/gpt-6.1-sol')).toBe(true)
    expect(isGptModel('openai/GPT-6')).toBe(true)
    expect(isGptModel('gpt')).toBe(true)
    expect(isGptModel('yf/deepseek-v4.1-flash')).toBe(false)
    expect(isGptModel('mc-gpt/claude-x')).toBe(false)
    expect(isGptModel('chatgpt-4o')).toBe(false)
    expect(isGptModel(undefined)).toBe(false)
  })
})

describe('Fast adapter bridge', () => {
  it('finds the prototype owning the stream on a live instance', () => {
    const { Adapter } = makeAdapterClass('openai-responses')
    expect(adapterPrototypeOf(new Adapter())).toBe(Adapter.prototype)
    expect(adapterPrototypeOf({})).toBeUndefined()
    expect(adapterPrototypeOf(null)).toBeUndefined()
  })

  it('adds service_tier for an enabled session and preserves the existing payload callback', async () => {
    const { Adapter, snapshot } = makeAdapterClass('openai-responses')
    const original = Adapter.prototype.streamWithSnapshot
    const bridge = installFastBridge(Adapter.prototype, id => id === 'session-1')
    try {
      const adapter = new Adapter()
      expect(await collect(adapter.streamWithSnapshot(request, snapshot)))
        .toEqual([{ input: 'kept', service_tier: 'priority', existing: true }])
      expect(snapshot.models.streamSimple).toHaveBeenCalledWith({}, {}, expect.objectContaining({ serviceTier: 'priority' }))
      // Another session stays untouched.
      expect(await collect(adapter.streamWithSnapshot({ ...request, sessionId: 'other' }, snapshot)))
        .toEqual([{ input: 'kept', service_tier: 'auto', existing: true }])
    } finally {
      bridge.dispose()
    }
    expect(Adapter.prototype.streamWithSnapshot).toBe(original)
  })

  it('never wraps non-GPT, purpose, session-less, non-Responses, or failing requests', async () => {
    const untouched = [{ input: 'kept', service_tier: 'auto', existing: true }]
    const { Adapter, snapshot } = makeAdapterClass('openai-responses')
    const bridge = installFastBridge(Adapter.prototype, () => true)
    try {
      const adapter = new Adapter()
      for (const variant of [
        { ...request, model: 'yf/deepseek-v4.1-flash' },
        { ...request, purpose: 'title' },
        { provider: request.provider, model: request.model },
        { ...request, provider: 'missing' },
      ] satisfies FastRequest[]) {
        expect(await collect(adapter.streamWithSnapshot(variant, snapshot))).toEqual(untouched)
      }
    } finally {
      bridge.dispose()
    }
    const completions = makeAdapterClass('openai-completions')
    const other = installFastBridge(completions.Adapter.prototype, () => true)
    try {
      expect(await collect(new completions.Adapter().streamWithSnapshot(request, completions.snapshot))).toEqual(untouched)
    } finally {
      other.dispose()
    }
  })

  it('replaces a wrap left by an earlier load instead of stacking', () => {
    const { Adapter } = makeAdapterClass('openai-responses')
    const original = Adapter.prototype.streamWithSnapshot
    installFastBridge(Adapter.prototype, () => true)
    const second = installFastBridge(Adapter.prototype, () => true)
    second.dispose()
    expect(Adapter.prototype.streamWithSnapshot).toBe(original)
  })
})

describe('Fast session controller', () => {
  it('uses a plugin-owned exact route', () => {
    expect(FAST_STATE_PATH).toBe('/dsh-better-reasoning-effort/fast-state')
  })

  it('reports support from the live adapter and keeps the flag per session', () => {
    const { Adapter } = makeAdapterClass('openai-responses')
    const original = Adapter.prototype.streamWithSnapshot
    const llm = { adapters: new Map([['magpie-responses', { adapter: new Adapter() }]]) }
    const controller = createFastController(() => llm)
    try {
      const base = { sessionId: 's1', provider: 'magpie-responses', model: 'mc-gpt/gpt-6.1-sol' }
      expect(controller.handle(base)).toEqual({ ok: true, value: { enabled: false, supported: true, active: false } })
      // The first supported read installed the bridge on the live prototype.
      expect(Adapter.prototype.streamWithSnapshot).not.toBe(original)
      expect(controller.handle({ ...base, enabled: true })).toEqual({ ok: true, value: { enabled: true, supported: true, active: true } })
      expect(controller.isEnabled('s1')).toBe(true)
      expect(controller.handle({ ...base, sessionId: 's2' })).toEqual({ ok: true, value: { enabled: false, supported: true, active: false } })
      // Same session on a non-GPT model: flag kept, not active, no button.
      expect(controller.handle({ ...base, model: 'yf/deepseek-v4.1-flash' }))
        .toEqual({ ok: true, value: { enabled: true, supported: false, active: false } })
      expect(controller.handle({ ...base, enabled: false })).toEqual({ ok: true, value: { enabled: false, supported: true, active: false } })
    } finally {
      controller.dispose()
    }
    expect(Adapter.prototype.streamWithSnapshot).toBe(original)
  })

  it('refuses invalid input and unsupported routes without throwing', () => {
    const controller = createFastController(() => undefined)
    expect(controller.handle(null)).toEqual({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(controller.handle({ sessionId: 's', provider: 'p', model: 'gpt-6', enabled: 'yes' }))
      .toEqual({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(controller.handle({ sessionId: 's', provider: 'p', model: 'gpt-6' }))
      .toEqual({ ok: true, value: { enabled: false, supported: false, active: false } })
    expect(controller.handle({ sessionId: 's', provider: 'p', model: 'gpt-6', enabled: true }))
      .toEqual({ ok: false, error: { code: 'UNSUPPORTED' } })
    controller.dispose()
  })
})
