/**
 * dsh-verify-gate — lib/tools.mjs
 * Agent tool definitions (pure: no cordis, no dsh-tools import — callers map
 * them through defineTool). Single source of truth; test/preflight.mjs
 * validates every definition against the REAL @deepseek-ai/dsh-tools
 * compiler before the plugin ever touches the web profile.
 *
 * The tool shells out to the `verify-gate` binary (github.com/LosEcher/
 * verify-gate): a declarative TOML manifest of typed assertions
 * (file/cmd/http/git/json) is executed mechanically and the JSON report is
 * returned. Exit contract: 0 all pass · 1 any fail · 2 tool error.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export function createToolDefs(deps) {
  const { binary, timeoutMs } = deps

  return [
    {
      name: 'verify_run',
      description:
        '按声明式验证清单（verify-gate TOML manifest：file 存在/包含/regex、cmd 退出码+输出、http 状态+body、git clean/branch、json 字段）机械执行验证，返回结构化报告（verdict/每项 pass|fail|na/证据）。用法：manifest 给路径或 manifestText 给内联 TOML 二选一；cwd 指定断言基准目录（缺省=当前工作区）。exit 语义已映射：verdict=pass 全过、fail 有失败、toolError=工具错误（清单解析失败等）。',
      parameters: {
        manifest: { type: 'string', description: 'TOML 清单文件路径（相对 cwd）；与 manifestText 二选一' },
        manifestText: { type: 'string', description: '内联 TOML 清单内容（写临时文件执行）；与 manifest 二选一' },
        cwd: { type: 'string', description: '断言执行基准目录（缺省=当前工作区目录；git/http/相对路径均相对它解析）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            verdict: { type: 'string' },
            exitCode: { type: 'integer' },
            toolError: { type: 'string' },
            manifest: { type: 'string' },
            durationMs: { type: 'integer' },
            checks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  index: { type: 'integer' },
                  name: { type: 'string' },
                  type: { type: 'string' },
                  result: { type: 'string' },
                  durationMs: { type: 'integer' },
                  detail: { type: 'string' },
                },
              },
            },
            lines: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
      },
      timeoutMs,
      async execute(args, exec) {
        const cwd = args.cwd ? resolve(args.cwd) : undefined
        let manifestPath = args.manifest
        let tmpDir
        try {
          if (args.manifestText) {
            tmpDir = await mkdtemp(join(tmpdir(), 'verify-gate-'))
            manifestPath = join(tmpDir, 'manifest.toml')
            await writeFile(manifestPath, String(args.manifestText), 'utf8')
          }
          if (!manifestPath) {
            return {
              verdict: 'toolError',
              toolError: 'manifest 或 manifestText 必填一个',
              lines: ['verify_run: manifest 或 manifestText 必填一个'],
            }
          }
          const bin = await resolveBinary(binary)
          if (!bin) {
            const msg =
              'verify-gate 二进制未找到。安装：cargo install verify-gate，或设置 VERIFY_GATE_BIN 环境变量 / 在 cordis.patch.yml 的 verify-gate 行 config.binary 指定路径。'
            return { verdict: 'toolError', toolError: msg, lines: [msg] }
          }
          const started = Date.now()
          const argv = [manifestPath, '--emit', 'json']
          if (cwd) argv.push('--cwd', cwd)
          const out = await run(bin, argv, {
            cwd,
            timeoutMs,
            signal: exec?.signal,
          })
          const durationMs = Date.now() - started
          if (out.timedOut) {
            return {
              verdict: 'toolError',
              exitCode: -1,
              toolError: `verify-gate 超时（>${Math.round(timeoutMs / 1000)}s）`,
              durationMs,
              lines: ['verify_run: 超时被终止'],
            }
          }
          let report
          try {
            report = JSON.parse(out.stdout)
          } catch {
            return {
              verdict: 'toolError',
              exitCode: out.code,
              toolError: `verify-gate 输出非 JSON：${(out.stderr || out.stdout || '').slice(0, 400)}`,
              durationMs,
              lines: ['verify_run: 二进制输出异常（可能是版本不匹配或清单错误）', (out.stderr || out.stdout || '').slice(0, 400)],
            }
          }
          // 三态如实呈现（2026-10-08）。verify-gate 的 per-check result 是
          // pass | fail | na 三态，且 `na` 既不算通过也不算失败。此前渲染把
          // 非 pass/fail 一律画成 `·`，而 `·` 同时被用来表示"未知态"⇒ 读的人
          // 分不清"这条不适用"与"这条没判"。现给 na 独立标记 `–`（en dash）。
          const markOf = (r) =>
            r === 'pass' ? '✔' : r === 'fail' ? '✘' : r === 'na' ? '–' : '?'
          const counts = { pass: 0, fail: 0, na: 0, other: 0 }
          for (const c of report.checks) {
            if (c.result === 'pass') counts.pass++
            else if (c.result === 'fail') counts.fail++
            else if (c.result === 'na') counts.na++
            else counts.other++
          }
          const lines = [
            `verify-gate ${report.version ?? ''} — ${report.manifest ?? manifestPath} — verdict: ${report.verdict}（exit ${report.exitCode ?? out.code}）`,
            `  计数: pass=${counts.pass} fail=${counts.fail} na=${counts.na}${counts.other ? ` other=${counts.other}` : ''}`,
            ...report.checks.map((c) => {
              const ms = c.durationMs ?? c.duration_ms ?? 0
              return `  ${markOf(c.result)} [${c.type}] ${c.name}: ${c.result}（${ms}ms）${c.detail ? ' — ' + String(c.detail).replace(/\n/g, '⏎').slice(0, 160) : ''}`
            }),
          ]
          // 全 na ⇒ verify-gate 已报 inconclusive + exit 2；这里再显式点明，
          // 避免任何下游把这行当成"通过"。
          if (counts.pass === 0 && counts.na > 0 && counts.fail === 0) {
            lines.push(`  ⚠ 全部 ${counts.na} 条都是 na（不适用/已禁用）—— 没有任何规则真正生效，**不构成通过**`)
          }
          if (report.checks.length === 0) lines.push('  （清单为空）')
          return { ...report, exitCode: report.exitCode ?? out.code, durationMs, lines }
        } catch (e) {
          return {
            verdict: 'toolError',
            toolError: String(e?.message ?? e),
            lines: [`verify_run: ${String(e?.message ?? e)}`],
          }
        } finally {
          if (tmpDir) {
            rm(tmpDir, { recursive: true, force: true }).catch(() => {})
          }
        }
      },
    },
  ]
}

async function resolveBinary(cfgBinary) {
  const candidates = []
  if (cfgBinary) candidates.push(cfgBinary)
  if (process.env.VERIFY_GATE_BIN) candidates.push(process.env.VERIFY_GATE_BIN)
  candidates.push('verify-gate', join(homedir(), '.cargo/bin/verify-gate'))
  const { access, constants } = await import('node:fs/promises')
  for (const c of candidates) {
    // 裸名必须逐目录扫 PATH。旧实现写的是 `resolve(c.includes('/') ? c : c)`
    // ——两条分支相同的死三元，裸名会被当成 `$PWD/verify-gate`，于是文件头注释
    // 承诺的 "PATH 'verify-gate'" 一步从未生效（只有 cwd 恰好有该文件时才"看起来能用"）。
    const paths = c.includes('/')
      ? [resolve(c)]
      : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, c))
    for (const full of paths) {
      try {
        await access(full, constants.X_OK)
        return full
      } catch {
        /* try next */
      }
    }
  }
  return null
}

function run(bin, args, { cwd, timeoutMs, signal }) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return done({ code: -1, stdout: '', stderr: String(e?.message ?? e), timedOut: false })
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const onAbort = () => {
      if (!settled) child.kill('SIGKILL')
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => {
      stdout += d
      if (stdout.length > 256 * 1024) child.kill('SIGKILL') // 防失控输出
    })
    child.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > 64 * 1024) child.stderr.destroy()
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      done({ code: -1, stdout, stderr: String(e?.message ?? e), timedOut })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      done({ code, stdout, stderr, timedOut })
    })
  })
}
