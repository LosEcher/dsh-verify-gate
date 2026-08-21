/**
 * dsh-verify-gate — index.mjs (host half)
 *
 * Cordis bundle row `verify-gate`:
 *   - registers the agent tool `verify_run` (wraps the verify-gate binary,
 *     github.com/LosEcher/verify-gate) via ctx.tools + @deepseek-ai/dsh-tools
 *
 * Binary resolution order: config.binary → $VERIFY_GATE_BIN → PATH
 * 'verify-gate' → ~/.cargo/bin/verify-gate. Missing binary → the tool
 * returns a clear install hint instead of crashing the tree.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createToolDefs } from './lib/tools.mjs'

export const name = 'dsh-verify-gate'
export const inject = ['tools']

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const defs = createToolDefs({
    binary: config.binary,
    timeoutMs: config.timeoutMs,
  })
  const disposers = []
  for (const def of defs) {
    try {
      disposers.push(ctx.tools.register(defineTool(def)))
    } catch (e) {
      ctx.logger?.error?.(`verify-gate: tool ${def.name} registration failed: ${e.message}`)
    }
  }
  return () => {
    for (const d of disposers) d()
  }
}

function resolveConfig(config) {
  return {
    binary: config.binary || '',
    timeoutMs: Number(config.timeoutMs) || 180000,
  }
}

apply.inject = inject
