import { createElement } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { PLUGIN_ID } from '../constants.js'
import { FastButton, type FastConnection } from './FastButton.js'
import type { ClientContext, SlotRegistrarFace } from './types.js'

/** Registers the session Fast toggle in the official composer input slot. */
export function registerFastModeSlot(ctx: ClientContext, t: Translate): () => void {
  const host = ctx as unknown as ClientContext & {
    slots?: SlotRegistrarFace
    connection?: FastConnection
  }
  if (!host.slots || !host.connection) return () => {}
  const button = (props: { sessionId?: string }) => createElement(FastButton, {
    ...props,
    connection: host.connection as FastConnection,
    t: (key: string) => t(key),
  })
  const injected = host.slots.inject('conversation.input.right', () => {
    host.slots?.register({
      name: 'conversation.input.right',
      id: `${PLUGIN_ID}-fast-toggle`,
      order: 30,
    }, button)
  })
  return typeof injected === 'function' ? injected as () => void : () => {}
}
