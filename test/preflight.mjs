/**
 * dsh-verify-gate — test/preflight.mjs
 * 预检：把 lib/tools.mjs 的工具定义喂给【真实】@deepseek-ai/dsh-tools 的
 * defineTool 编译器（从 web profile 解析），任何参数 schema / output schema
 * 编译错误都会在这里抛出——绝不让 web 插件树再炸。
 *
 * Run: node test/preflight.mjs   （在改 index.mjs / lib/tools.mjs 后必跑）
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { createToolDefs } from '../lib/tools.mjs'

const PROFILE = process.env.DSH_PROFILE ?? join(homedir(), '.dsh/profiles/web')
const ANCHOR = `${PROFILE}/`

if (!existsSync(`${PROFILE}/node_modules`)) {
  console.error(`profile 不存在：${PROFILE}`)
  process.exit(1)
}

const require = createRequire(ANCHOR)
let entry
try {
  entry = require.resolve('@deepseek-ai/dsh-tools')
} catch (e) {
  console.error(`无法从 ${ANCHOR} 解析 @deepseek-ai/dsh-tools：${e.message}`)
  process.exit(1)
}
const tools = await import(pathToFileURL(entry).href)
if (typeof tools.defineTool !== 'function') {
  console.error('dsh-tools 未导出 defineTool，API 又变了？')
  process.exit(1)
}

const defs = createToolDefs({ binary: 'verify-gate', timeoutMs: 180000 })

let n = 0
for (const def of defs) {
  try {
    const compiled = tools.defineTool(def) // 编译失败会抛错
    n += 1
    console.log(`preflight ok: ${def.name} -> ${compiled?.name ?? 'compiled'}`)
  } catch (e) {
    console.error(`preflight FAILED: ${def.name}: ${e.message}`)
    process.exit(1)
  }
}
console.log(`preflight: ${n} tool(s) compiled against real dsh-tools`)
