// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { FastModelLabel } from '../src/client/injection/fast-model-label.js'
import { fastKey, publishFast } from '../src/client/fast-status-store.js'

const provider = { id: 'magpie-responses', name: 'Magpie' }
const model = { id: 'mc-gpt/gpt-6.1-sol', name: 'GPT-6.1 Sol' }
const resolveBadge = (text: unknown) => String(text)

async function renderLabel(sessionId: string, placement: 'trigger' | 'menu' | 'option' = 'trigger') {
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  root.render(createElement(FastModelLabel, { sessionId, provider, model, placement, selected: true, resolveBadge }))
  await vi.waitFor(() => expect(node.textContent).toContain('GPT-6.1 Sol'))
  return { node, root }
}

describe('Fast model-name marker', () => {
  it('reflects the same session toggle immediately, without changing the model name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true, value: { active: false, enabled: false, supported: true } }) })))
    const id = 'label-session-1'
    const key = fastKey(id, provider.id, model.id)
    try {
      const { node, root } = await renderLabel(id)
      expect(node.querySelector('.bre-fast-model-bolt')).toBeNull()
      publishFast(key, { active: true, enabled: true, supported: true })
      await vi.waitFor(() => expect(node.querySelector('.bre-fast-model-bolt')).not.toBeNull())
      expect(node.querySelector('path')?.getAttribute('d')).toBe('m13 2-9 12h7l-1 8 10-12h-7l0-8Z')
      publishFast(key, { active: false, enabled: false, supported: true })
      await vi.waitFor(() => expect(node.querySelector('.bre-fast-model-bolt')).toBeNull())
      expect(node.textContent).toBe('GPT-6.1 Sol')
      root.unmount()
    } finally { vi.unstubAllGlobals() }
  })

  it('does not show a bolt in menus or for an unrelated session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true, value: { active: false, enabled: false, supported: true } }) })))
    const active = fastKey('label-session-2', provider.id, model.id)
    publishFast(active, { active: true, enabled: true, supported: true })
    try {
      const menu = await renderLabel('label-session-2', 'menu')
      const other = await renderLabel('label-session-3')
      expect(menu.node.querySelector('svg')).toBeNull()
      expect(other.node.querySelector('svg')).toBeNull()
      menu.root.unmount()
      other.root.unmount()
    } finally { vi.unstubAllGlobals() }
  })

  it('never queries Fast when no session or GPT model is selected', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    try {
      root.render(createElement(FastModelLabel, {
        provider, model, placement: 'trigger', selected: true, resolveBadge,
      }))
      await vi.waitFor(() => expect(node.textContent).toBe('GPT-6.1 Sol'))
      expect(node.querySelector('svg')).toBeNull()
      root.render(createElement(FastModelLabel, {
        sessionId: 'label-non-gpt', provider,
        model: { id: 'yf/deepseek-v4.1-flash', name: 'DeepSeek' },
        placement: 'trigger', selected: true, resolveBadge,
      }))
      await vi.waitFor(() => expect(node.textContent).toBe('DeepSeek'))
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { root.unmount(); vi.unstubAllGlobals() }
  })

  it('retains badge text and ignores a stale status request after a newer toggle', async () => {
    let resolve!: (response: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(response => { resolve = response })))
    const id = 'label-session-4'
    const key = fastKey(id, provider.id, model.id)
    const badgeModel = { ...model, badge: { tone: 'brand', text: 'New' } }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    try {
      root.render(createElement(FastModelLabel, { sessionId: id, provider, model: badgeModel, placement: 'trigger', selected: true, resolveBadge }))
      await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
      publishFast(key, { active: true, enabled: true, supported: true })
      resolve({ json: async () => ({ ok: true, value: { active: false, enabled: false, supported: true } }) })
      await vi.waitFor(() => expect(node.querySelector('.bre-fast-model-bolt')).not.toBeNull())
      expect(node.textContent).toBe('NewGPT-6.1 Sol')
    } finally { root.unmount(); vi.unstubAllGlobals() }
  })
})
