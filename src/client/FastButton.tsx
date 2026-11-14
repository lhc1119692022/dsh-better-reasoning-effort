/**
 * The optional GPT Fast toggle: an icon-only lightning button placed to the
 * right of the composer effort slider. It renders NOTHING until the Host
 * confirms the session's current route/model can carry the priority tier,
 * and nothing again on any failure, so the slider is never affected.
 *
 * The bolt glyph is borrowed from Delthin/dsh-fast's composer button (the
 * official-style lightning icon).
 *
 * @module dsh-better-reasoning-effort/client/FastButton
 */
import { Component, createElement, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FAST_STATE_PATH } from '../constants.js'
import { fastKey, fastSnapshot, publishFast } from './fast-status-store.js'

/** Delthin/dsh-fast's bolt path, verbatim. */
const BOLT_PATH = 'm13 2-9 12h7l-1 8 10-12h-7l0-8Z'

export interface FastStatus {
  enabled: boolean
  supported: boolean
  active: boolean
}

type FastResult = { ok: true; value: FastStatus } | { ok: false; error?: { code?: string } }

/**
 * POST the Fast state route.
 * @param body - session, route and model; `enabled` writes the flag.
 * @returns the status, or undefined on any failure.
 */
export async function requestFastState(body: {
  sessionId: string
  provider: string
  model: string
  enabled?: boolean
}, signal?: AbortSignal): Promise<FastStatus | undefined> {
  try {
    const response = await fetch(FAST_STATE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
    const result = await response.json() as FastResult
    return result.ok ? result.value : undefined
  } catch {
    return undefined
  }
}

export interface FastButtonProps {
  sessionId: string
  provider: string
  model: string
  t: (key: string) => string
}

function FastToggle({ sessionId, provider, model, t }: FastButtonProps): ReactNode {
  const key = fastKey(sessionId, provider, model)
  const [status, setStatus] = useState<FastStatus | undefined>(() => fastSnapshot(key))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void requestFastState({ sessionId, provider, model }, controller.signal).then(next => {
      if (controller.signal.aborted) return
      publishFast(key, next)
      setStatus(next)
    })
    return () => { controller.abort() }
  }, [key, sessionId, provider, model])

  const toggle = useCallback(() => {
    if (pending || status === undefined) return
    setPending(true)
    setFailed(false)
    void requestFastState({ sessionId, provider, model, enabled: !status.enabled }).then(next => {
      setPending(false)
      if (next === undefined) {
        setFailed(true)
        return
      }
      publishFast(key, next)
      setStatus(next)
    })
  }, [key, pending, status, sessionId, provider, model])

  if (status === undefined || !status.supported) return null
  const on = status.active
  const title = failed ? t('fastFailedTitle') : on ? t('fastActiveTitle') : t('fastInactiveTitle')
  return createElement('button', {
    type: 'button',
    className: 'bre-fast-button',
    'data-active': on ? 'true' : 'false',
    'aria-pressed': on,
    'aria-busy': pending,
    'aria-label': on ? t('fastAriaOn') : t('fastAriaOff'),
    title,
    disabled: pending,
    onClick: toggle,
  },
  createElement('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, createElement('path', { d: BOLT_PATH })))
}

/** A failure inside the toggle renders nothing; the slider stays intact. */
class FastBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    console.warn('[dsh-better-reasoning-effort] Fast button failed', error)
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** The isolated Fast toggle (renders nothing unless the Host confirms support). */
export function FastButton(props: FastButtonProps): ReactNode {
  return createElement(FastBoundary, null, createElement(FastToggle, props))
}
