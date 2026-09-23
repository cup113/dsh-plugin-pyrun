# dsh-plugin-pyrun

DeepSeek Harness 的 Python 快捷执行工具插件：模型直接给 Python 源码，一步返回结果。

它存在的理由是消除在 Windows/PowerShell 里驱动 Python 的三个痛点：

1. **转义地狱** —— 源码经工具参数（JSON）直接写进子进程 `stdin`，不经过任何 shell 引号层。
2. **两步成本** —— 不再需要"先写临时脚本、再执行"，一次调用完成。
3. **编码异常** —— 全链路 UTF-8：`python -X utf8 -u -`，stdout/stderr 按 UTF-8 解码，中文与 emoji 原样往返。

前台与后台两种模式与内置 `pwsh` 工具同语义（同一份沙箱策略、同一套提权审批、同一套标记词汇）。

## 安装

```powershell
dsh plugin --profile web add link:D:/Projects/dsh-plugin-pyrun
```

显式写 `link:`：`link:` 安装只在 profile 里建一个软链，**不往 profile 装任何依赖**（本机 profile 里 `personal-track` 就是 `link:`，它的 `zod` / `schemastery` 都不在 profile 根）。这样 profile 里绝不会多出核心包副本，改完本仓库代码重启即生效。

`dsh plugin add` 写 `~/.dsh` 并运行 pnpm，在受限沙箱下需要一次性提权。安装成功后该包作为一层 bundle 进入 profile（因为它声明了 `dsh.bundle.patch`）。

**装完必须重启 `dsh`。** 宿主半身是 Node ESM 模块，只有重启才会重新加载；profile 的 `patchReload: live` 只重读 patch，不重载已缓存的模块。

### 核心包契约：消费方 profile 里只允许存在一份

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-sandbox` 的声明分两处，各司其职：

| 位置 | 作用 |
|---|---|
| `peerDependencies` | 运行契约：真正跑这份代码的实例由 harness 提供（非 `link:` 安装时走 `~/.dsh/profiles/node_modules` 回退层，其中 `@deepseek-ai/*` 全部软链到 `...\node_modules\@deepseek-ai\dsh` 的宿主安装树），与宿主 agent loop 共享**同一份物理副本** |
| `devDependencies`（精确锁定 `0.1.5-rc.2`） | 只为本仓库服务：本插件以 `link:` 安装，Node 按 realpath 从 `D:\Projects\dsh-plugin-pyrun` 解析用它自己的 `import`，而回退层不是它的祖先目录（缺这份副本会直接 `ERR_MODULE_NOT_FOUND` 加载失败）。**消费方 profile 永不安装依赖的 devDependencies**，所以它不会落到 profile 里 |

**绝不要把这两个包写进 `dependencies`。** 除 `link:` 之外的安装方式（`file:` / 打包 / registry / git）都会让 profile 安装插件的普通依赖——本机 profile 用 `nodeLinker: hoisted`，会直接把它们物化到 profile 根 `node_modules`——于是进程里出现第二份 `dsh-tools`。它用模块局部 `Symbol('@deepseek-ai/dsh-tools.scheduler')` 当工具调度器的键，两份副本的 Symbol 不相等 → `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 `undefined` → **该进程内所有工具调用**都崩在 agent-loop 的 `tool-calls` 上：

```
Cannot read properties of undefined (reading 'prepare')
```

`defineTool` 与沙箱辅助函数都不携带跨包的 Symbol 状态，因此插件本地那份 devDependencies 副本是惰性的、不会参与宿主的调度器查表；只有被**消费方**安装并提升进 profile 的那一份才造成分裂。`link:` 安装更是连普通依赖都不装（本机 profile 里 `personal-track` 的 `zod` / `schemastery` 都不在 profile 根，可作对照）。`pnpm test` 的清单断言守着「必须在 peer、可在 dev、绝不可在 dependencies」这条规则。

## 用法

工具名 `python`，参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `code` | string（必填） | Python 程序原文，经 `stdin` 执行 |
| `workdir` | string | 工作目录；缺省用会话 cwd，相对路径按会话 cwd 解析 |
| `timeout_ms` | number | 前台超时；缺省用执行器默认值，并受部署上限约束。**后台运行时不适用** |
| `run_in_background` | boolean | 后台运行，立即返回 job id（该组合存在时才广告） |
| `sandbox_permissions` | enum | 更宽的沙箱模式，仅用于对刚被拒绝的调用做一次性重试，需配 `justification` |
| `justification` | string | 一句话说明，展示在审批面板里 |

结果标记：

- `[exit code: N]` —— 非零退出码是结果而非错误，N 为 Python 的真实退出码
- `[timed out after Nms]` / `[aborted]`
- `[stderr]` 分节承载 stderr
- `[output truncated; full output: <path>]` —— 超长输出截尾，完整内容落在溢出文件里
- `[sandbox: file access denied under <mode> mode]` + 同轮提权提示

后台作业用 `job_output` 收割、`job_kill` 停止，`job_list` 查看名册（kind 显示为 `python`）。

## 版本契约与迁移说明（来自动态插件 `pyrun-1` / `pkg-5`）

本包由本会话内的动态 Cordis 插件 `pyrun-1` 迁移而来，其最终版本为 `pkg-5`。迁移过程中最大的教训是**运行版本 ≠ 签出版本**：

| 树 | 版本 |
|---|---|
| 实际运行的安装树 `D:\Programs\nvm\v24.19.0\node_modules\@deepseek-ai\dsh` | **0.1.5-rc.2** ← 行为以此为准 |
| 签出仓库 `D:\Projects\deepseek-harness` | 0.1.6-alpha.2 |

动态版第一版（`pkg-4`）按签出仓库的 API 写，运行即失败：

```
Error: Cannot read properties of undefined (reading 'Symbol(dsh.scope)')
```

根因是 `jobs` 注册表的 `scopeOf(owner.ctx)`：**0.1.5-rc.2 的 `JobStart.owner` 要求 Agent 活对象**，而按 0.1.6 的契约传了 SessionId 字符串（`exec.agent.id`）。`pkg-5` 改按运行版契约重写后全绿，本包即 `pkg-5` 的等价移植。

### 本包当前依赖的运行契约（0.1.5-rc.2）

- `ctx.shell.run(spec): Promise<ShellRunResult>` —— 前台执行直接返回结果
- `ctx.shell.start(spec): ShellProcess` —— 后台执行，**同步**返回句柄
- `ShellProcess`：`status` / `exitCode` / `signal` / `done` / `readOutput()` / `kill()`，**没有 `.observed`**
- `jobs.start({ kind, label, owner, run })`，其中 `owner` 是 **Agent 活对象**
- `JobHooks = { cancel(reason?), done, readOutput?(): string }` —— 输出是**消费型游标**，通知由生产者自己拼
- `JobOutcome = { status, detail?, output? }`

### 升级到 0.1.6+ 时的迁移表

| 面 | 0.1.5-rc.2（本包当前） | 0.1.6-alpha.2（升级改法） |
|---|---|---|
| 前台执行 | `ctx.shell.run(spec)` → `ShellRunResult` | `ctx.shell.execute(spec)` → `ShellExecution`，再 `await handle.result()` |
| 后台启动 | `ctx.shell.start(spec)` 同步 → `ShellProcess` | `ctx.shell.execute({ ...spec, signal })` 异步 → `ShellExecution`（spawn 发生在 registry starter 内） |
| 作业 owner | `owner: exec.agent`（Agent 对象） | `owner: exec.agent.id`（SessionId） |
| 输出泵 | hooks 的 `readOutput()` 消费游标 | `spec.output: [JobOutputSource]` 拉源，由 registry 按自己节奏泵；`proc.observed.stdout/stderr.readFrom(byte)`（非消费读） |
| 作业终态 | 自拼 `processOutcome` | 同形；另把 sandbox notes 并入 `detail` |
| 免超时 | 无 `onExpiry` 字段，`start` 天然忽略 `timeoutMs` | 显式 `onExpiry: 'none'` |
| 生产者面 | `run()` 无参 | `run(job)` 收到 `JobHandle`（`append` / `updateProgress`） |
| 输出字段 | `JobOutcome.output` | `JobOutcome.result` |

`kind: 'python'` 两版都合法：注册表把 kind 当作不透明的 id 命名空间（`'pwsh'` 就是既有先例，它并不在 `JobKindMap` 里）。

### 已废弃的历史 workaround

**1. 跨域审批**（动态插件时期）。动态包跑在 `node:vm` 沙箱 realm 里，其构造的请求对象被 api 网关的 `isPlainRecord` 拒绝——那道检查用宿主域的 `prototype` 做恒等判断，沙箱域对象不匹配，于是所有提权静默降级为 `unavailable`。当时的绕过办法是 `Object.create(null)`（null 原型在两域都通过检查）。

**树内进程插件不需要这个绕过**：进程内对象本来就是宿主域。本包直接使用官方助手 `approveEscalation()`，错误文案与动态版逐字相同。

> 上游仍值得修：`packages/api/gateway/src/stream-protocol.ts` 的 `isPlainRecord` 应当跨域容忍（`cordis-host-runner/guard.ts` 里同名的那个函数就是特意做成跨域容忍的）。任何动态插件调用 `approval.request()` 或 `userQuestions.ask` 都会踩到它。

**2. 退出码坍缩。** `pwsh -Command` 下原生命令的非零退出码会坍缩成 `1`（宿主级既有行为，内置 `pwsh` 工具同样受影响；shell 层的 `exit N` 正常）。修法是在命令尾部追加 `; exit $LASTEXITCODE`，本包对 Windows 分支这么做。bash 执行器天然透传退出码，故按 `process.platform` 分流命令串。

**3. stdin 直灌。** 代码经 JSON 参数写进 `stdin` 而不是 argv：没有引号层、没有 32K 命令行长度上限、`-u` 免缓冲、`-X utf8` 免 GBK 干扰。

### 动态版验证矩阵（`pkg-5` 实测，本包接口等价）

| 验证项 | 结果 |
|---|---|
| 编码往返（中文 / emoji / 箭头，`repr` 对照） | 原样无损 |
| SyntaxError → stderr UTF-8 traceback，`<stdin>` 模式 | 通过 |
| 退出码 `sys.exit(3)` → `[exit code: 3]` | 通过（依赖 `; exit $LASTEXITCODE`） |
| 沙箱：工作区内写 + 删 / 越界拒绝 + 标记 + 提权提示 | 与 pwsh 工具同语义 |
| 超时（2s 杀 60s sleep）→ 部分输出保留 | 通过 |
| 截断（1.3MB）→ 尾部保留 + 溢出文件路径 | 通过 |
| 提权：审批面板 → 授权 → 越界写成功 → 清理 | 通过 |
| 后台：启动即返 id → `job_output` 增量收割（含 `[stderr]` 分节） | 通过 |
| 后台：等待超时 → 部分输出 + 作业存活 | 通过 |
| 后台：`job_kill` → 结算 `killed`，缓冲输出仍可读 | 通过 |
| 后台：非零退出 → `[status: completed, exit code: 3]` | 通过 |
| 后台：完成通知唤醒 | 通过 |
| 参数互斥：`timeout_ms` + `run_in_background` | 明确报错拒绝 |

## 开发

- **无构建步骤**：纯 ESM JavaScript（`src/index.js`），没有 `prepare` 脚本，因此不会触发 pnpm 的构建拦截（`allowBuilds`）。
- **核心包必须声明为 `peerDependencies`**：`@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/dsh-sandbox`（`approveEscalation` 与标记文案）被真实 `import`。写进 `dependencies` 会让**消费方 profile** 把它们安装并提升进 profile 根 `node_modules`，造成第二份物理副本、Symbol 分裂、全进程工具调用崩溃（见上「核心包契约」）；同时它们必须精确锁定在 `devDependencies` 里，否则 `link:` 安装的插件解析不到自己的 `import`。`test/manifest.test.mjs` 是这条规则的常驻断言。
- **lockfile 里的 `dependencies: @deepseek-ai/cordis` 不是本插件的声明**：`package.json` 把 cordis 放在 `peerDependencies`，是 pnpm 的 `autoInstallPeers` 把它自动装进本仓库树的产物，只为本地可加载。消费方 profile 一律按 `package.json` 的 peer 处理。
- **测试**：`pnpm test`（`node --test test/`）。在本 DSH 沙箱内 `node --test test/` 会因 piped-stdio spawn 被沙箱拒绝（`spawn EPERM`，沙箱边界而非测试失败），此时改用 `node test/manifest.test.mjs` 或 `node --test --test-isolation=none "test/*.test.mjs"`。
- **不依赖 `@deepseek-ai/dsh-llm`**：`HarnessError` 只在 `errorInfo()` 的 `instanceof` 判定里被识别，而进程内插件拿到的是另一份独立拷贝，`instanceof` 必为假——与其静默退化，不如根本不走那条路（取消由运行时的规范通道处理）。
- **改宿主半身 → 重启 `dsh`**；改 `cordis.patch.yml` 可由 `patchReload: live` 生效。
- 重装/更新：重复执行上面的 `dsh plugin --profile web add ...`。

## 已知限制

- **没有 promote-on-timeout**：内置 `pwsh`/`bash` 工具在前台超时后会把命令转成后台作业继续跑；本工具前台超时即杀，只保留已产出的部分输出。
- **没有 Config**：超时、输出上限一律用执行器的默认值与上限。
- **与同名工具冲突**：本插件在 web profile 里注册 `python`。重启后不要再激活动态插件 `pyrun-1`（它注册同名工具，且进程内已不存在）。
- **依赖 PATH 中的 `python`**：插件不探测解释器路径。

## 故障诊断：所有工具调用失败

症状：该进程内**任何**工具调用都失败（不只是 `python`），报 `Cannot read properties of undefined (reading 'prepare')`，栈落在 `dsh-agent-loop` 的 `tool-calls`。重启 `dsh`、删插件、重装都无效。

排查（期望值都写在注释里）：

```powershell
# 1. 插件是否把核心包物化进了 profile？期望：False（这一份就是元凶）
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-tools"
# 2. 本仓库那份只应是 devDependency 的惰性副本，且版本与宿主一致
pnpm why @deepseek-ai/dsh-tools
# 3. 全机副本清点：profile 侧不应出现，宿主安装树下有且只有一份
Get-ChildItem "$env:USERPROFILE\.dsh" -Recurse -Directory -Filter 'dsh-tools' -ErrorAction SilentlyContinue
```

处置：确认清单里它不在 `dependencies`（在就改回 `devDependencies` 并 `pnpm install`）；profile 侧 `dsh plugin --profile web remove dsh-plugin-pyrun` 再重新 `add`（让 pnpm 重算 profile 的 node_modules）；**完全重启 `dsh`**（`patchReload: live` 不重载已缓存的模块）。

⚠️ **崩溃轮次会毒化会话**：那一轮留下了没有对应 `tool/result` 的孤儿 `tool_calls`，此后该会话每轮都报 `INVALID_REQUEST: ... tool calls need immediate results`；插件修好也救不回来，只能弃用并新建会话。

⚠️ **上游同一缺陷未修**：`0.1.5-rc.2` 的 `dsh-tools` 里两处 `TOOL_RUNTIME_SCHEDULER` 都是模块局部 `Symbol(...)`（`lib/index.js:51` 与 `2430`，另有 `lib/types/index.js:51`），没有 `Symbol.for` 兜底。升级 harness 换不掉"插件自带副本"这条路径，本插件只能保证自己不再制造副本。
