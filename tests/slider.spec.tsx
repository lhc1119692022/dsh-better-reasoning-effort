/**
 * ComposerSlider unit tests: level resolution against the directory snapshot
 * and the commit path (optimistic select via the upstream key/drag contract,
 * plus rejection rollback), without the DOM injector.
 */

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerSlider, effectiveEffortIndex, sliderLevels } from '../src/client/ComposerSlider.js'
import type { ModelDirectoryLike, ModelDirectoryStateLike } from '../src/client/types.js'

/** A directory fixture with a five-level ladder around 'medium'. */
function fixture(state?: Partial<ModelDirectoryStateLike>): {
  directory: ModelDirectoryLike
  selectSpy: ReturnType<typeof vi.fn>
  update: (next: ModelDirectoryStateLike) => void
} {
  let base: ModelDirectoryStateLike = {
    current: { provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'medium' },
    routable: true,
    groups: [{
      id: 'aliyun',
      name: 'Aliyun',
      models: [{
        id: 'qwen-max',
        name: 'Qwen Max',
        reasoning: {
          defaultEffort: 'medium',
          efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
        },
      }],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    ...state,
  }
  const listeners = new Set<() => void>()
  const selectSpy = vi.fn(async (selection: { provider: string; model: string; reasoningEffort?: string }) => {
    base = { ...base, current: { provider: selection.provider, model: selection.model, ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort } } }
    for (const listener of [...listeners]) listener()
  })
  return {
    directory: {
      store: {
        getSnapshot: () => base,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      load: vi.fn(async () => base),
      select: selectSpy,
    },
    selectSpy,
    update: (next: ModelDirectoryStateLike) => {
      base = next
      for (const listener of [...listeners]) listener()
    },
  } as unknown as {
    directory: ModelDirectoryLike
    selectSpy: ReturnType<typeof vi.fn>
    update: (next: ModelDirectoryStateLike) => void
  }
}

async function mount(directory: ModelDirectoryLike): Promise<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> {
  return mountIn(directory)
}

/** Mount inside a fake official menu so the commit's focus handoff has a target. */
async function mountIn(directory: ModelDirectoryLike): Promise<{ root: ReturnType<typeof createRoot>; container: HTMLElement; menu: HTMLElement }> {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  document.body.appendChild(menu)
  const container = document.createElement('div')
  menu.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(ComposerSlider, { directory, t: (key: string) => key }))
  // createRoot renders are scheduled; give the initial commit a tick.
  await new Promise(resolve => setTimeout(resolve, 0))
  return { root, container, menu }
}

function pressKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('effectiveEffortIndex', () => {
  const levels = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }]
  it('prefers the session effort, then the adapter default, then the middle', () => {
    expect(effectiveEffortIndex(levels, { current: { provider: 'a', model: 'm', reasoningEffort: 'high' }, routable: true, groups: [], failures: [], status: 'ready', pending: null, error: null })).toBe(3)
    expect(effectiveEffortIndex(levels, { current: { provider: 'a', model: 'm' }, routable: true, groups: [{ id: 'a', name: 'A', models: [{ id: 'm', name: 'M', reasoning: { defaultEffort: 'low', efforts: levels } }] }], failures: [], status: 'ready', pending: null, error: null })).toBe(1)
    expect(effectiveEffortIndex(levels, { current: { provider: 'a', model: 'm' }, routable: true, groups: [{ id: 'a', name: 'A', models: [{ id: 'm', name: 'M' }] }], failures: [], status: 'ready', pending: null, error: null })).toBe(2)
  })
  it('hides the slider for models with fewer than two levels', async () => {
    const one = fixture({ current: { provider: 'aliyun', model: 'qwen-max' }, groups: [{ id: 'aliyun', name: 'Aliyun', models: [{ id: 'qwen-max', name: 'Qwen Max', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }] }] })
    expect(sliderLevels(one.directory.store.getSnapshot())).toHaveLength(0)
    const { root, container } = await mount(one.directory)
    expect(container.querySelector('.bre-slider-hint')).not.toBeNull()
    expect(container.querySelector('input[type="range"]')).toBeNull()
    // The model row still replicates upstream (with the default effort label).
    expect(container.querySelector('.bre-model-row')).not.toBeNull()
    root.unmount()
  })
})

describe('ComposerSlider commit', () => {
  it('renders the upstream visual skeleton (track, fx canvas, flare, white knob) and rests on medium', async () => {
    const { directory } = fixture()
    const { root, container } = await mount(directory)
    expect(container.querySelector('.bre-effort-track')).not.toBeNull()
    expect(container.querySelector('canvas.bre-effort-canvas')).not.toBeNull()
    expect(container.querySelector('.bre-effort-flare')).not.toBeNull()
    const knob = container.querySelector<HTMLElement>('.bre-effort-knob')
    expect(knob).not.toBeNull()
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    // The rest position lands in the mount-sync effect (passive effects flush
    // asynchronously); wait for it before checking the rest state.
    await vi.waitFor(() => expect(range.value).toBe('2'))
    // The stops are felt while dragging, never drawn: no locator dots.
    expect(container.querySelector('.bre-effort-markers')).toBeNull()
    expect(container.querySelectorAll('.bre-effort-marker')).toHaveLength(0)
    // The snap behind that feel: the range runs on whole stops.
    expect(range.step).toBe('1')
    // The popover body replicates upstream: separator + model row after the slider.
    expect(container.querySelector('.bre-menu-separator')).not.toBeNull()
    const row = container.querySelector<HTMLButtonElement>('.bre-model-row')
    expect(row).not.toBeNull()
    expect(row?.querySelector('.bre-model-row-name')?.textContent).toBe('Qwen Max')
    expect(row?.querySelector('.bre-model-row-effort')?.textContent).toBe('Medium')
    root.unmount()
  })

  it('commits a selection through directory.select via the keyboard contract', async () => {
    const { directory, selectSpy } = fixture()
    const { root, container } = await mount(directory)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    // The mount-sync effect moves the thumb from its initial 0 onto the
    // session's medium only on a passive effect flush. Pressing before that
    // lands makes the arrow step FROM 0 (off) and commit 'low' instead of
    // 'high' — a race that lost on the faster Node 24 CI. Wait for the rest
    // position first, exactly like the visual-skeleton case above.
    await vi.waitFor(() => expect(range.value).toBe('2'))
    // Arrow keys move one step per press: 2 (medium) → 3 (high) → 4 (max).
    pressKey(range, 'ArrowRight')
    await vi.waitFor(() => expect(selectSpy).toHaveBeenCalledWith({ provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'high' }))
    pressKey(range, 'ArrowRight')
    await vi.waitFor(() => expect(selectSpy).toHaveBeenCalledWith({ provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'max' }))
    root.unmount()
  })

  it('rolls back to the committed level when the select rejects', async () => {
    const { directory, selectSpy, update } = fixture()
    // Faithful to the real ModelDirectory: a refused selection surfaces on the
    // store (status/error) and rethrows — the slider rests on the committed
    // level while the store's error line shows.
    selectSpy.mockImplementationOnce(async () => {
      update({
        ...directory.store.getSnapshot(),
        status: 'error',
        error: 'refused',
      })
      throw new Error('refused')
    })
    const { root, container } = await mount(directory)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    // Rest on the failure's announcement first (the optimistic snap moves the
    // thumb before the rejection settles), then check the rollback position.
    pressKey(range, 'ArrowRight')
    // Both the announcement and the rollback position inside one waitFor —
    // the thumb moves optimistically before the rejection settles.
    await vi.waitFor(() => {
      expect(container.querySelector('.bre-effort-sr')?.textContent).toContain('refused')
      expect(range.value).toBe('2')
    })
    root.unmount()
  })

  it('rolls back when the directory resolves the refusal as a result (0.1.6-alpha.2)', async () => {
    // 0.1.6-alpha.2 RESOLVES {ok:false} on refusal instead of throwing. This
    // fixture's committed selection carries no explicit effort, so the
    // post-await store read cannot recover the rollback on its own: without
    // normalizing the refusal the thumb stays on the failed level.
    const { directory, selectSpy, update } = fixture({ current: { provider: 'aliyun', model: 'qwen-max' } })
    selectSpy.mockImplementationOnce(async () => {
      update({ ...directory.store.getSnapshot(), status: 'error', error: 'session/invalid: no such effort' })
      return { ok: false, error: { code: 'session/invalid', message: 'no such effort' } }
    })
    const { root, container } = await mount(directory)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    // The adapter default (medium) is the rest position before any pick.
    await vi.waitFor(() => expect(range.value).toBe('2'))
    pressKey(range, 'ArrowRight')
    await vi.waitFor(() => {
      expect(container.querySelector('.bre-effort-sr')?.textContent).toContain('no such effort')
      expect(range.value).toBe('2')
    })
    root.unmount()
  })

  it('hands focus to the menu before the busy state disables the input (issue #13)', async () => {
    // The official shell closes the menu when a blur leaves the card: disabling
    // the focused input at commit time dropped focus onto <body>. The commit
    // must move focus onto the menu element itself first — the same handoff the
    // pane switch performs — so the menu stays open for follow-up picks.
    const { directory, selectSpy } = fixture()
    const { root, container, menu } = await mountIn(directory)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    await vi.waitFor(() => expect(range.value).toBe('2'))
    pressKey(range, 'ArrowRight')
    // Synchronous: the handoff runs in the commit's sync section, before the
    // first await, so the disabled input never owns the focus.
    expect(document.activeElement).toBe(menu)
    expect(selectSpy).toHaveBeenCalled()
    root.unmount()
  })

  it('commits against the live snapshot without re-loading the catalog', async () => {
    // The old commit re-ran directory.load() to revalidate levels; on a cold
    // third-party catalog that swings the shared catalog into its loading state
    // and visually collapses the open menu. The live snapshot's levels are the
    // same data the official reload refreshes on every menu open.
    const { directory, selectSpy } = fixture()
    const loadSpy = directory.load as ReturnType<typeof vi.fn>
    const { root, container } = await mount(directory)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    await vi.waitFor(() => expect(range.value).toBe('2'))
    loadSpy.mockClear()
    pressKey(range, 'ArrowRight')
    await vi.waitFor(() => expect(selectSpy).toHaveBeenCalledWith({ provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'high' }))
    expect(loadSpy).not.toHaveBeenCalled()
    root.unmount()
  })

  it('follows the in-flight preview in the model row effort label', async () => {
    const { directory, selectSpy } = fixture()
    const { root, container } = await mount(directory)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
    await vi.waitFor(() => expect(range.value).toBe('2'))
    const rowEffort = container.querySelector('.bre-model-row-effort')!
    expect(rowEffort.textContent).toBe('Medium')
    // ArrowRight commits 'high' optimistically: the row label follows the
    // preview as soon as React flushes the optimistic snap, not only after
    // the store settles.
    pressKey(range, 'ArrowRight')
    await vi.waitFor(() => expect(rowEffort.textContent).toBe('High'))
    await vi.waitFor(() => expect(selectSpy).toHaveBeenCalled())
    root.unmount()
  })
})

describe('GPT Fast toggle beside the slider', () => {
  async function mountWithSession(directory: ModelDirectoryLike, sessionId?: string) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(createElement(ComposerSlider, { directory, t: (key: string) => key, ...(sessionId === undefined ? {} : { sessionId }) }))
    await new Promise(resolve => setTimeout(resolve, 0))
    return { root, container }
  }
  const gpt = {
    current: { provider: 'magpie-responses', model: 'mc-gpt/gpt-6.1-sol', reasoningEffort: 'high' },
    groups: [{ id: 'magpie-responses', name: 'Magpie', models: [{ id: 'mc-gpt/gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }],
  }

  it('renders the bolt only when the host confirms support, and toggles it', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { enabled?: boolean }
      const enabled = body.enabled === true
      return { json: async () => ({ ok: true, value: { enabled, supported: true, active: enabled } }) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const { directory } = fixture(gpt)
      const { root, container } = await mountWithSession(directory, 'session-a')
      const button = await vi.waitFor(() => {
        const found = container.querySelector<HTMLButtonElement>('.bre-effort-row > .bre-fast-button')
        expect(found).not.toBeNull()
        return found!
      })
      expect(button.querySelector('path')?.getAttribute('d')).toBe('m13 2-9 12h7l-1 8 10-12h-7l0-8Z')
      expect(button.getAttribute('aria-pressed')).toBe('false')
      expect(JSON.parse((fetchSpy.mock.calls[0]![1]).body)).toEqual({ sessionId: 'session-a', provider: 'magpie-responses', model: 'mc-gpt/gpt-6.1-sol' })
      button.click()
      await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'))
      expect(JSON.parse((fetchSpy.mock.calls[1]![1]).body)).toMatchObject({ enabled: true })
      // The slider itself is untouched.
      expect(container.querySelector('input[type="range"]')).not.toBeNull()
      root.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders nothing when the host says unsupported, fails, or no session is known', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true, value: { enabled: false, supported: false, active: false } }) })))
    try {
      const { directory } = fixture()
      const unsupported = await mountWithSession(directory, 'session-b')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unsupported.container.querySelector('.bre-fast-button')).toBeNull()
      expect(unsupported.container.querySelector('input[type="range"]')).not.toBeNull()
      unsupported.root.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    try {
      const { directory } = fixture(gpt)
      const failing = await mountWithSession(directory, 'session-c')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(failing.container.querySelector('.bre-fast-button')).toBeNull()
      expect(failing.container.querySelector('input[type="range"]')).not.toBeNull()
      failing.root.unmount()
      const anonymous = await mountWithSession(directory)
      expect(anonymous.container.querySelector('.bre-fast-button')).toBeNull()
      anonymous.root.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
