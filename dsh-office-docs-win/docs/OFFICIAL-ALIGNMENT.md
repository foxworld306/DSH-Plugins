# 与 DSH 官方插件规范的对齐审计

审计日期：2026-11-05 · 插件版本 1.0.0 · 运行时 `dsh 0.2.1-rc.5` / `@deepseek-ai/cordis 4.0.5`

## 一、依据（这些是本机可查的官方来源，不是猜的）

| 来源 | 用途 |
| --- | --- |
| `@deepseek-ai/dsh-package-manifest` README + `src/types.ts` 类型声明 | package.json 里 `dsh` / `engines` 的公开字段与必填项 |
| `@deepseek-ai/dsh-app-boot` README「Profiles」+ `lib/index.js` 里的 `evaluatePluginCompatibility` / `unmetRequirements` / `bundlePatchFiles` | 装载前的兼容性判定、bundle patch 解析——**这是真正会拦你的代码** |
| `@deepseek-ai/dsh-tools` `ToolDefinition` / `ToolOutputDefinition` / `defineTool` / `parameterSchemaSpecToJsonSchema` | 工具定义的确切形状（含编译后的参数 schema） |
| `@deepseek-ai/dsh-skill` 类型声明 + `SkillRegistry` 实现 | 技能注册的两种契约：`register()` 与 `registerProvider()`，rank 与缓存失效规则 |
| `@deepseek-ai/dsh-skill-office`（官方 office 技能包） | 磁盘型技能的**参考实现**：provider 形状、`BUNDLED_SKILL_RANK`、`resourceBase` |
| `dsh-computer-use-win` 0.5.3、`@michengai/dsh-archive-manager` 1.2.5（本机已装的第三方插件） | 真实发布包的 `engines.dsh` / `peerDependencies` / `files` / `dsh.bundle` 写法 |

> 官方仓库里的 `docs/cookbook/adding-a-package.md` 没有随 npm 包发布，本机查不到；上面这些是等价的、且更接近执行路径的证据。

## 二、package.json 逐字段对照

| 字段 | 官方要求 | 审计前 | 现在 |
| --- | --- | --- | --- |
| `name` / `version` | 必填 | ✅ | ✅ |
| `type` | Cordis 是 ESM | ✅ `module` | ✅ |
| `main` / `exports` | 指向入口；`./package.json` 应可解析（GUI 读显示信息要用） | ✅ | ✅ |
| `dsh.manifestVersion` | 可选，当前格式为 `1` | ✅ 1 | ✅ 1 |
| `dsh.bundle.patch` | 相对包根的路径，可以是数组 | ✅ | ✅（官方 `bundlePatchFiles()` 实测解析为 `./cordis.patch.yml`） |
| `engines.dsh` | 可选；**一旦声明，`peerDependencies` 就不再参与兼容判定** | ❌ 缺失 → 装到任何版本都不报兼容问题 | ✅ `>=0.2.0-rc.1 <0.3.0-0` |
| `engines.node` | 与 DSH 运行时一致 | ⚠️ `>=20`（偏松） | ✅ `^22.19.0 \|\| >=24.0.0` |
| `peerDependencies` | 引用框架包时声明；本机 profile 是 `autoInstallPeers: false` 且只装了 `cosmokit`/`schemastery` | ❌ 无 | 保持无 —— 插件**不 import 任何 `@deepseek-ai/*` 包**，声明 peer 只会制造 unmet peer 噪音；兼容性交给 `engines.dsh` 单独判定 |
| `keywords` | 便于市场检索 | 缺 `dsh` / `deepseek-harness` | ✅ 已补 |
| `files` | 决定 npm 打包内容 | 缺 `CHANGELOG.md` | ✅ 已补（LICENSE/README 由 npm 强制包含） |
| `license` | 声明 + 仓库里有 LICENSE 文件 | 只声明，没文件 | ✅ 已补 MIT LICENSE |
| `repository` / `homepage` / `bugs` | npm 惯例 | ❌ 无（本机没有 git remote） | ⏳ 待你填：有仓库地址后加 |
| `dsh.client` | 只有带 Web UI 的插件才需要 | 不适用 | 不适用（纯 host 插件） |
| `icon` | 可选，Plugins 页显示 | 无 | ⏳ 可选，需要一张 data URL 图片 |

### 兼容性实测（用官方函数，不是我手算）

```
runtime version: 0.2.1-rc.5
compatible: manifest accepted by the official evaluator
bundle.patch -> ["./cordis.patch.yml"]
```

坑记一笔：`>=0.2.0-rc.1 <0.3.0-0` 用**裸 semver** 判定会判 `0.2.1-rc.5` **不满足**（预发布版只被“同一 major.minor.patch 且带预发布”的比较器接受）。DSH 内部调用时传了 `{ includePrerelease: true }`，所以实际是接受的。自己写检查脚本时别漏这个参数，否则会误以为自己的插件不兼容。

## 三、Cordis 插件形状

| 要求 | 现状 |
| --- | --- |
| `export const name`（稳定 Loader 身份） | ✅ `office-docs-win` |
| `export const inject`（声明的服务） | ✅ `['skills','tools','workingDirectory']` |
| `export function apply(ctx, config)` | ✅ |
| 生命周期用 `ctx.effect()` 挂载，交给 fiber 回收 | ✅ 技能注册已改为 `ctx.effect(() => …)` |
| 卸载/重载不得留下重复注册 | ✅ mock 套件断言：re-apply 恰好产生一对新注册，旧的可被释放 |
| `Config`（schemastery 校验） | 未提供 —— 本插件没有配置项；官方 `dsh-skill-office` 用它是为了 `assetRoot`/`node`/`cli` 覆盖，我们直接从 `import.meta.url` 推导，不需要 |

## 四、工具定义

官方两种写法：`defineTool({ parameters: <DSL>, output: { schema: <DSL>, render } })` 编译成 `ToolDefinition`，或直接产出 `ToolDefinition`。**我们手写的是编译后的形态**，已逐项核对：

| 检查点 | 官方编译产物 | 我们 |
| --- | --- | --- |
| 参数根 schema | `{ type:'object', properties, required? }`（不设根 `additionalProperties`） | 完全一致 |
| 输出声明 | `output: { schema: JsonSchemaNode, render(args, value): ContentBlock[] }` | ✅ `{ schema:{type:'string'}, render }` |
| 输出渲染 | `[{ type:'text', text }]` | ✅ |
| `execute(args, exec)` 必须观察 `exec.signal` | 文档明确要求 | ✅ 渲染已改为异步并把 `exec.signal` 传进 `renderDocument()`，中止时 `taskkill /T /F` 杀掉 PowerShell 树（实测 1.8 s 中止，13.5 s 正常渲染） |

不引入 `@deepseek-ai/dsh-tools` 是有意的：profile 里没有这份包，import 会拉到第二份框架实例，注册对象就不是宿主那一套。手写等价结构反而更稳。

## 五、技能注册

官方有两条路，我们原来只用了一条：

- `ctx.skills.registerProvider(create)` —— 官方 `dsh-skill-office` 走这条，技能正文按需从磁盘读，改文档不用重启。
- `ctx.skills.register(skill)` —— 运行时注册，**会失效目录缓存**，rank 250（provider 是 600，数值小的优先）。

审计中发现的问题（B16）：只注册 provider 时，宿主里这个技能**根本查不到**（`skill "office-docs-win" is unknown`），而同一份代码在裸 registry 里是好的。原因在缓存：宿主在会话启动时就收集过目录，`registerProvider()` 不失效缓存，于是目录里永远没有我们这一条。
现在两条都注册：`register()` 保证可见与缓存失效，`registerProvider()` 保证正文按需重读。同一层同名时 rank 小的运行时条目胜出，所以不会出现两条。

## 六、本次审计发现并修掉的问题

| 编号 | 问题 | 后果 | 处理 |
| --- | --- | --- | --- |
| B14 | `engines.dsh` 缺失 | 装到未来版本 DSH 上也不会提示不兼容，直接崩或用错 API | 声明 `>=0.2.0-rc.1 <0.3.0-0` |
| B15 | `renderDocument()` 用 `spawnSync` | 渲染期间**整个宿主进程**卡住（21 页文档实测 23 s），所有会话一起等，且无法取消 | 改异步 `spawn` + `exec.signal` → `taskkill /T`，保留 15 min 兜底 |
| B16 | 技能只在 provider 路径注册 | 宿主目录里查不到该技能（只有靠 `~/.dsh/skills` 的副本才看得见） | `register()` + `registerProvider()` 双路 |
| B17 | 技能注册用 `globalThis` 存 disposer，每次 apply 先销毁再注册 | 目录里残留指向已销毁 provider 的条目，报 “unknown or no longer available” | 改为 `ctx.effect` 持有，随 fiber 回收 |
| B18 | 清单字段/打包清单不全（LICENSE、CHANGELOG、keywords、engines.node） | 不像一个可发布包 | 已补 |

## 七、还没做 / 建议

1. **`repository` 字段**：等你有公开仓库地址再填，npm 页面会显示源码链接。
2. **Plugins 页图标**：`package.json.icon` 支持 data URL 图片；纯 host 插件没图标会显示默认方块。
3. **发布步骤**（本机没有 npm 凭证，没执行）：
   ```powershell
   cd office-docs-win-plugin
   npm pack --dry-run          # 先看 files 里到底打了什么
   npm publish                 # 或内网 registry：npm publish --registry <url>
   # 同事端：
   dsh plugin --profile web add dsh-office-docs-win
   ```
   用 `--dry-run` 先确认包里不含 `test/`、`dist/`、大文件。
4. **配置项**：如果以后想让 `assetRoot` 可覆盖（打包成 exe 的场景），再引入 schemastery 的 `Config`，与官方 `dsh-skill-office` 一致。
5. **技能副本去留**：`install.mjs` 目前仍会把技能复制到 `~/.dsh/skills`（rank 400，会**盖住**插件内置的 600）。等重启后确认内置路径可见，建议把这一步改为可选（`--copy-skill`），否则两份文档会漂移。
