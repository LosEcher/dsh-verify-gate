/**
 * dsh-verify-gate — host 入口冒烟测试（跨版本门禁）。
 *
 * 用**运行中 profile 的真实宿主库**（@deepseek-ai/dsh-tools）加载插件入口
 * index.mjs，用桩 ctx 驱动 apply()，再拿**真实注册出来的工具对象**执行一次。
 * 锁住四类只有"装到真宿主里"才暴露的漂移：
 *   1. 模块能加载 + defineTool 真能编译 verify_run 的参数/输出 schema
 *      （插件自带 preflight.mjs 只编译纯定义；这里走的是 index.mjs 的真实注册路径）；
 *   2. 注入契约（inject=['tools']）与"注册失败被 try/catch 吞掉"的失败模式
 *      —— 注册数为 0 即视为门禁红；
 *   3. **二进制解析**：显式配置 → $VERIFY_GATE_BIN → PATH → ~/.cargo/bin
 *      （用临时目录里的假二进制验证 PATH 这一步真的生效，不赌本机装了没装）；
 *   4. 执行契约：argv（`<manifest> --emit json`）、manifestText 落成临时清单文件、
 *      以及"二进制缺失 ⇒ 带补救指引的 toolError"而不是抛异常。
 *
 * 设计要点（沿用 dsh-scheduler / dsh-dashboards 先例）：
 *   - 依赖从 profile 解析（test/fixtures/resolve-host.mjs），不赌本机软链；
 *   - 解析不到宿主库 ⇒ skip 并打印原因，而不是假装通过（防空转）；
 *   - 假二进制写在临时目录、PATH/HOME 用完即还原，绝不碰真实 ~/.cargo/bin。
 *
 * 运行：node --test test/host-smoke.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 宿主库探测链：显式 env → ~/.dsh/profiles（link 插件的公共层）→ web profile。 */
function findHostRoot() {
  const candidates = [
    process.env.DSH_HOST_MODULES,
    process.env.DSH_PROFILE_ROOT,
    join(homedir(), '.dsh', 'profiles'),
    join(homedir(), '.dsh', 'profiles', 'web'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-tools'))) return root
  }
  return null
}

const HOST_ROOT = findHostRoot()
const SKIP = HOST_ROOT
  ? false
  : '未找到宿主 node_modules（profile 未安装 @deepseek-ai/dsh-tools），跳过而非假装通过'

/** 桩 ctx：捕获注册到的工具对象与日志。 */
function makeCtx() {
  const registered = []
  const logs = []
  return {
    registered,
    logs,
    tools: { register: (t) => { registered.push(t); return () => {} } },
    logger: {
      info: (m) => logs.push(`info: ${String(m)}`),
      warn: (m) => logs.push(`warn: ${String(m)}`),
      error: (m) => logs.push(`error: ${String(m)}`),
    },
  }
}

async function loadPlugin() {
  process.env.DSH_HOST_MODULES = HOST_ROOT
  register(new URL('./fixtures/resolve-host.mjs', import.meta.url).href)
  return await import(`../index.mjs?smoke=${Date.now()}`)
}

const execArg = () => ({ signal: new AbortController().signal })

/**
 * 假 verify-gate：把 argv 与清单内容落到 $FAKE_SIDECAR 供断言，再输出一份
 * 合法的 JSON 报告（契约见 lib/tools.mjs:104-125 的解析路径）。
 */
const FAKE_BIN = `#!/bin/bash
# PATH 被门禁收窄成"只有本假二进制所在目录"以验证解析逻辑，脚本自己需要
# 恢复正常 PATH —— cat/printf 里的 cat 不是 builtin，靠窄 PATH 会静默读到空内容。
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
{
  echo "ARGV=$*"
  echo "MANIFEST_CONTENT=$(cat "$1")"
} > "$FAKE_SIDECAR"
printf '%s' '{"version":"0.0.0-fake","verdict":"pass","exitCode":0,"checks":[{"type":"file","name":"gate-selftest","result":"pass","durationMs":1}]}'
exit 0
`

function withEnv(patch, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return (async () => fn())().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test('host 冒烟：真实 dsh-tools 编译 verify_run + 注册/参数契约', { skip: SKIP }, async () => {
  // 纯定义模块的契约（参数名是模型可见面，改名=破坏性变更）
  const { createToolDefs } = await import('../lib/tools.mjs')
  const defs = createToolDefs({ binary: 'verify-gate', timeoutMs: 180000 })
  assert.equal(defs.length, 1)
  assert.equal(defs[0].name, 'verify_run')
  assert.deepEqual(Object.keys(defs[0].parameters).sort(), ['cwd', 'manifest', 'manifestText'])

  const ctx = makeCtx()
  const mod = await loadPlugin()
  assert.equal(mod.name, 'dsh-verify-gate')
  assert.deepEqual(mod.inject, ['tools'], 'inject 是宿主服务门控，漂移会导致 ctx.tools 不可用')
  assert.equal(mod.apply.inject, mod.inject, 'apply.inject 与模块级 inject 必须一致（Cordis 两种读法）')

  const dispose = mod.apply(ctx, {})
  assert.equal(ctx.registered.length, 1, `defineTool 编译失败会被静默吞掉（日志：${ctx.logs.join(' | ')}）`)
  const tool = ctx.registered[0]
  assert.equal(tool.name, 'verify_run')
  assert.equal(typeof tool.execute, 'function')

  // 参数缺失必须**先于任何 IO**报错，且是返回值不是抛异常
  const missing = await tool.execute({}, execArg())
  assert.equal(missing.verdict, 'toolError')
  assert.match(missing.toolError, /必填/)

  dispose?.()
})

test('host 冒烟：PATH 解析 + 执行契约（临时假二进制，hermetic）', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vg-fake-'))
  const sidecar = join(dir, 'invocation.txt')
  const fake = join(dir, 'verify-gate')
  writeFileSync(fake, FAKE_BIN, 'utf8')
  chmodSync(fake, 0o755)
  writeFileSync(sidecar, '')

  const ctx = makeCtx()
  try {
    await withEnv({ PATH: dir, VERIFY_GATE_BIN: undefined, FAKE_SIDECAR: sidecar }, async () => {
      const mod = await loadPlugin()
      mod.apply(ctx, {}) // 不传 binary / env：唯一出路是扫 PATH
      assert.equal(ctx.registered.length, 1)
      const res = await ctx.registered[0].execute(
        { manifestText: '[[check]]\ntype = "file"\npath = "x"\n' },
        execArg(),
      )
      assert.equal(res.verdict, 'pass', 'PATH 里的二进制应被解析并执行')
      assert.equal(res.checks.length, 1)
      assert.equal(res.exitCode, 0)
    })

    const invocation = readFileSync(sidecar, 'utf8')
    assert.match(invocation, /--emit json/, 'argv 契约：<manifest> --emit json')
    assert.match(invocation, /MANIFEST_CONTENT=\[\[check\]\]/, 'manifestText 必须落成真实清单文件再交给二进制')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host 冒烟：二进制缺失 ⇒ 带补救指引的 toolError（不抛、不静默）', { skip: SKIP }, async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-vg-nohome-'))
  const ctx = makeCtx()
  try {
    await withEnv(
      { HOME: emptyHome, PATH: join(emptyHome, 'empty-bin'), VERIFY_GATE_BIN: undefined },
      async () => {
        const mod = await loadPlugin()
        mod.apply(ctx, { binary: join(emptyHome, 'not-installed') })
        assert.equal(ctx.registered.length, 1, '解析不到二进制也必须先把工具注册好')
        const res = await ctx.registered[0].execute({ manifestText: 'x' }, execArg())
        assert.equal(res.verdict, 'toolError')
        assert.match(res.toolError, /未找到/)
        assert.match(res.toolError, /VERIFY_GATE_BIN/, '补救指引必须可操作（装/环境变量/配置三选一）')
      },
    )
  } finally {
    rmSync(emptyHome, { recursive: true, force: true })
  }
})

// 三态渲染用的假二进制（2026-10-08）：返回 mixed pass+na 与全 na 两种报告。
// 存在理由：verify-gate 的 per-check result 是三态（pass|fail|na），而 `na`
// 既不算通过也不算失败。此前渲染把非 pass/fail 一律画成 `·`，与"未知态"混淆。
const FAKE_BIN_TRISTATE = `#!/bin/bash
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
case "$TRISTATE_MODE" in
  all-na)
    printf '%s' '{"version":"0.0.0-fake","verdict":"inconclusive","exitCode":2,"passed":0,"checks":[
      {"type":"cmd","name":"only-disabled","result":"na","durationMs":0,"detail":"disabled"}]}'
    exit 2 ;;
  *)
    printf '%s' '{"version":"0.0.0-fake","verdict":"pass","exitCode":0,"passed":1,"checks":[
      {"type":"file","name":"real-pass","result":"pass","durationMs":1},
      {"type":"cmd","name":"scope-miss","result":"na","durationMs":0,"detail":"scope mismatch"}]}'
    exit 0 ;;
esac
`

test('host 冒烟：na 三态如实渲染，不冒充通过（假二进制，hermetic）', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vg-tri-'))
  const fake = join(dir, 'verify-gate')
  writeFileSync(fake, FAKE_BIN_TRISTATE, 'utf8')
  chmodSync(fake, 0o755)

  const ctx = makeCtx()
  try {
    // ① mixed pass + na ⇒ 计数行如实、na 用独立标记 –
    await withEnv({ PATH: dir, VERIFY_GATE_BIN: undefined, TRISTATE_MODE: 'mixed' }, async () => {
      const mod = await loadPlugin()
      mod.apply(ctx, {})
      const res = await ctx.registered[0].execute({ manifestText: 'x' }, execArg())
      const text = res.lines.join('\n')
      assert.match(text, /计数: pass=1 fail=0 na=1/, '必须给出三态计数')
      assert.match(text, /– \[cmd\] scope-miss: na/, 'na 用独立标记 –，不与未知态 · 混淆')
      assert.doesNotMatch(text, /不构成通过/, '有真 pass 时不得报警示')
    })

    // ② 全 na ⇒ 显式警示，且绝不出现"通过"字样误导
    await withEnv({ PATH: dir, VERIFY_GATE_BIN: undefined, TRISTATE_MODE: 'all-na' }, async () => {
      const mod = await loadPlugin()
      mod.apply(ctx, {})
      const res = await ctx.registered[0].execute({ manifestText: 'x' }, execArg())
      const text = res.lines.join('\n')
      assert.equal(res.verdict, 'inconclusive')
      assert.equal(res.exitCode, 2)
      assert.match(text, /计数: pass=0 fail=0 na=1/)
      assert.match(text, /不构成通过/, '全 na 必须显式警示"不构成通过"')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
