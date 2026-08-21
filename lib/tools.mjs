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
          const lines = [
            `verify-gate ${report.version ?? ''} — ${report.manifest ?? manifestPath} — verdict: ${report.verdict}（exit ${report.exitCode ?? out.code}）`,
            ...report.checks.map((c) => {
              const mark = c.result === 'pass' ? '✔' : c.result === 'fail' ? '✘' : '·'
              const ms = c.durationMs ?? c.duration_ms ?? 0
              return `  ${mark} [${c.type}] ${c.name}: ${c.result}（${ms}ms）${c.detail ? ' — ' + String(c.detail).replace(/\n/g, '⏎').slice(0, 160) : ''}`
            }),
          ]
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
  for (const c of candidates) {
    try {
      const full = resolve(c.includes('/') ? c : c)
      const { access } = await import('node:fs/promises')
      await access(full)
      return full
    } catch {
      /* try next */
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
