# dsh-verify-gate

DSH 插件：把 [verify-gate](https://github.com/LosEcher/verify-gate)（声明式验证清单执行器）包装成 agent 工具 `verify_run`。

- **`verify_run`**：按 TOML 清单（`file` 存在/包含/regex、`cmd` 退出码+输出、`http` 状态+body、`git` clean/branch、`json` 字段）机械执行验证，返回结构化报告（`verdict` / 每项 `pass|fail|na` / 证据明细）。`manifest`（路径）或 `manifestText`（内联 TOML）二选一，`cwd` 指定断言基准目录。

把「验证」从 agent 的散文行为变成 exit 0/1/2 门禁——改完必跑、不过 blocked。

## 安装

```sh
# 二进制（工具本体，crates.io 或 GitHub Release）
cargo install verify-gate

# 插件（link 本地开发 / github 依赖）
dsh plugin --profile web add /path/to/dsplugins/dsh-verify-gate
# 或 pnpm install 后把 dsh-verify-gate 加入 profile package.json dependencies + dsh.profile.bundles
```

二进制解析顺序：`cordis.patch.yml` 的 `verify-gate` 行 `config.binary` → `$VERIFY_GATE_BIN` → PATH `verify-gate` → `~/.cargo/bin/verify-gate`。缺失时工具返回安装提示，不拖垮插件树。

## 验证

```sh
node --check index.mjs lib/tools.mjs
node test/preflight.mjs          # 用真实 @deepseek-ai/dsh-tools 编译工具定义
pnpm dsh --profile web --dump-config | grep -A6 'verify-gate'   # 行存在
```

改 host 代码后必须重启 dsh web；`verify_run` 在新会话可见（注入时序）。

## Manifest 示例（内联）

```toml
[[check]]
name = "构建产物存在"
type = "file"
path = "target/release/verify-gate"

[[check]]
name = "测试通过"
type = "cmd"
cmd = "cargo test"
stdout_contains = "test result: ok"
timeout_secs = 180
```

## License

MIT
