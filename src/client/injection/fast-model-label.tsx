/** Non-interactive Fast marker in the official composer's model-label slot. */
import { createElement, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
interface ModelLabelOwner {
  provider: Pick<ModelProviderGroup, 'id' | 'name'>
  model: ModelCatalogModel & { badge?: { tone: string; text: unknown } }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}
import { isGptModel } from '../../fast-mode/bridge.js'
import { PLUGIN_ID } from '../../constants.js'
import { requestFastState } from '../FastButton.js'
import { fastKey, fastRevision, fastSnapshot, publishFast, subscribeFast } from '../fast-status-store.js'
import type { ClientContext, SlotRegistrarFace } from '../types.js'

const BOLT_PATH = 'm13 2-9 12h7l-1 8 10-12h-7l0-8Z'
type Props = ModelLabelOwner & {
  sessionId?: string
  resolveBadge: (text: unknown) => string
}

export function FastModelLabel({ sessionId, provider, model, placement, resolveBadge }: Props): ReactNode {
  const key = fastKey(sessionId ?? '', provider.id, model.id)
  const subscribe = useCallback((listener: () => void) => subscribeFast(key, listener), [key])
  const snapshot = useCallback(() => fastSnapshot(key), [key])
  const status = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    if (placement !== 'trigger' || !sessionId || !isGptModel(model.id)) return
    const controller = new AbortController()
    // A query that began before a toggle must not overwrite its newer answer.
    const revision = fastRevision(key)
    void requestFastState({ sessionId, provider: provider.id, model: model.id }, controller.signal).then(next => {
      if (!controller.signal.aborted && fastRevision(key) === revision) publishFast(key, next)
    })
    return () => { controller.abort() }
  }, [key, sessionId, provider.id, model.id, placement])

  // The single slot replaces the stock label: retain names and badge text in
  // all placements, including menus and model options where no bolt is shown.
  const badge = model.badge === undefined ? null : createElement('span', {
    className: 'bre-fast-model-badge', 'data-tone': model.badge.tone,
  }, resolveBadge(model.badge.text))
  const bolt = placement === 'trigger' && status?.active === true
    ? createElement('svg', {
      className: 'bre-fast-model-bolt', viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
      strokeLinejoin: 'round', 'aria-hidden': true,
    }, createElement('path', { d: BOLT_PATH }))
    : null
  return createElement('span', { className: 'bre-fast-model-label' },
    bolt,
    placement === 'trigger' ? badge : null,
    createElement('span', { className: 'bre-fast-model-name' }, model.name),
    placement === 'trigger' ? null : badge,
  )
}

/** Own the official per-session slot; never modify the native trigger DOM. */
export function registerFastModelLabel(ctx: ClientContext): () => void {
  const slots = (ctx as unknown as { slots?: SlotRegistrarFace }).slots
  const locale = ctx.locale as typeof ctx.locale & {
    resolveText?: (text: unknown) => string
  }
  const injected = slots?.inject('conversation.input.model.label', () => {
    slots?.register({
      name: 'conversation.input.model.label',
      id: `${PLUGIN_ID}-fast-model-label`,
      inject: (sessionId?: string) => ({
        sessionId,
        resolveBadge: (text: NonNullable<ModelLabelOwner['model']['badge']>['text']) =>
          locale.resolveText?.(text) ?? (typeof text === 'string' ? text : ''),
      }),
    }, FastModelLabel)
  })
  return typeof injected === 'function' ? injected as () => void : () => {}
}
