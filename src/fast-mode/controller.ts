import { FAST_CHANNEL } from '../constants.js'
import { isGptModel, type FastCapability } from './bridge.js'

export { FAST_CHANNEL }
export const FAST_ENDPOINT = 'state'
const FAST_PROVIDER = 'magpie-responses'
const CACHE_MS = 3_000

type Selection = { provider?: unknown; model?: unknown }
type Agent = { session: object }
type SessionState = {
  enabled: boolean
  route?: string
  capability?: FastCapability
  checkedAt?: number
}
export interface FastContext {
  agents: { get(id: string): Agent | undefined }
  sessionProjections: {
    snapshot(session: object, keys: string[]): { values: { modelSelection?: { next?: Selection } } }
  }
  agentDefaultModel: { currentSelection(): Selection | undefined }
  llm: { prepareCall(config: { provider: string; model: string }, signal?: AbortSignal): Promise<unknown> }
  connection: { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>): unknown } }
}

type FastStatus = {
  enabled: boolean
  supported: boolean
  active: boolean
  provider: string | null
  model: string | null
  serviceTier: 'priority'
  reason: string | null
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message, details: {} } }
}

export function createFastController(ctx: FastContext, probe: (resolve: () => unknown) => Promise<FastCapability>) {
  const states = new WeakMap<object, SessionState>()
  const stateOf = (session: object): SessionState => {
    let state = states.get(session)
    if (!state) {
      state = { enabled: false }
      states.set(session, state)
    }
    return state
  }
  const selectionOf = (session: object): Selection | undefined => {
    try {
      return ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection?.next
        ?? ctx.agentDefaultModel.currentSelection()
    } catch {
      return ctx.agentDefaultModel.currentSelection()
    }
  }
  const isEnabled = (sessionId: string): boolean => {
    const agent = ctx.agents.get(sessionId)
    return agent !== undefined && stateOf(agent.session).enabled
  }

  async function status(agent: Agent, signal?: AbortSignal): Promise<FastStatus> {
    const selection = selectionOf(agent.session)
    const state = stateOf(agent.session)
    const provider = typeof selection?.provider === 'string' ? selection.provider : null
    const model = typeof selection?.model === 'string' ? selection.model : null
    const base: FastStatus = { enabled: state.enabled, supported: false, active: false,
      provider, model, serviceTier: 'priority', reason: null }
    if (!isGptModel(model)) return { ...base, reason: 'Fast is available only for GPT models' }
    if (provider !== FAST_PROVIDER) return { ...base, reason: 'Fast is available only on the Magpie Responses route' }

    try {
      const route = JSON.stringify([provider, model])
      if (state.route !== route || state.capability === undefined || Date.now() - (state.checkedAt ?? 0) > CACHE_MS) {
        state.capability = await probe(() => ctx.llm.prepareCall({ provider, model }, signal))
        state.route = route
        state.checkedAt = Date.now()
      }
      const supported = state.capability.supported && state.capability.api === 'openai-responses'
      return { ...base, supported, active: supported && state.enabled,
        reason: supported ? null : 'This model call path cannot accept Fast parameters' }
    } catch {
      return { ...base, reason: 'The model route is not ready; Fast support could not be checked' }
    }
  }

  async function handle(endpoint: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (endpoint !== FAST_ENDPOINT) return failure('NOT_FOUND', 'Unknown Fast endpoint')
    if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_ARGUMENT', 'Invalid Fast request')
    const payload = input as { sessionId?: unknown; enabled?: unknown }
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0 || payload.sessionId.length > 256
      || (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')) {
      return failure('INVALID_ARGUMENT', 'Invalid Fast request')
    }
    const agent = ctx.agents.get(payload.sessionId)
    if (!agent) return failure('SESSION_NOT_READY', 'Session is not ready')
    const current = await status(agent, signal)
    if (payload.enabled !== undefined) {
      if (payload.enabled && !current.supported) return failure('FAST_UNAVAILABLE', current.reason ?? 'Fast is unavailable')
      stateOf(agent.session).enabled = payload.enabled
      return { ok: true, value: { ...current, enabled: payload.enabled, active: payload.enabled && current.supported } }
    }
    return { ok: true, value: current }
  }

  return { isEnabled, handle }
}
