# Pi Extensions

[![CI](https://github.com/Luca4Don3/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/Luca4Don3/pi-extensions/actions/workflows/ci.yml)

[Pi](https://pi.dev) 扩展集合：一个仓库统一管理，一次安装、按需启用、统一更新。

## 包含的扩展

每个插件目录都是**完整独立的 Pi 包**（自带 `package.json`），可以单独安装：

| 插件 | 目录 | 安装 | 作用 |
| --- | --- | --- | --- |
| Subagent | `extensions/subagent/` | `pi install ~/pi-extensions/extensions/subagent` | 把任务委派给独立上下文的子 agent（single / parallel / chain） |
| Chinese Prompt | `extensions/chinese-prompt/` | `pi install ~/pi-extensions/extensions/chinese-prompt` | 注入中文强约束 system prompt，推理与输出全程简体中文 |
| OpenCode Fallback | `extensions/opencode-fallback/` | `pi install ~/pi-extensions/extensions/opencode-fallback` | 受限及未知模型固定代理，其余模型直连优先；模型请求不重放 |
| Token Speed | `extensions/pi-token-speed/` | `pi install ~/pi-extensions/extensions/pi-token-speed` | 状态栏实时显示 TPS / TTFT / token 统计；收录自上游 pi-token-speed（MIT），见 `UPSTREAM.md` |

## 仓库结构

```text
pi-extensions/
├── extensions/
│   ├── subagent/
│   │   ├── index.ts              # 工具入口
│   │   ├── agents.ts             # agent 发现
│   │   ├── model-config.ts       # 模型与思考等级解析
│   │   ├── concurrency.ts        # 并发调度
│   │   ├── output-buffer.ts      # 输出缓冲与去重
│   │   ├── process-lifecycle.ts  # 子进程生命周期
│   │   ├── spawn-failure.ts      # 启动失败诊断
│   │   ├── usage.ts              # 用量统计
│   │   ├── message-output.ts     # 结果提取
│   │   ├── examples/agents/      # 示例 agent 定义
│   │   └── tests/                # 离线测试
│   ├── chinese-prompt/
│   │   ├── index.ts
│   │   └── package.json
│   ├── opencode-fallback/
│   │   ├── index.ts
│   │   ├── package.json
│   │   └── tests/                # 离线测试
│   └── pi-token-speed/
│       ├── index.ts              # 上游入口转发
│       ├── package.json
│       ├── src/                  # 上游 0.12.0 源码（MIT）
│       ├── LICENSE.md
│       └── UPSTREAM.md
├── .github/workflows/ci.yml
├── tsconfig.json
├── package.json                  # 根 manifest：pi.extensions 声明所有插件入口
├── LICENSE
└── README.md
```

`package.json` 用 glob 声明入口，新增插件通常不需要改它：

```json
{
  "pi": {
    "extensions": ["extensions/*/index.ts"]
  }
}
```

## 设计原则

- 一个 GitHub 仓库集中收录所有自研 Pi Extension
- 每个插件保留独立目录与 `package.json`，可单独安装
- 不发布 npm 包，不开发自定义安装器，不修改 Pi 核心
- 安装、更新、卸载全部交给 Pi 原生包管理器
- 优先按需安装，同时兼容整仓 Git 安装

已知限制：在不使用 npm、不拆分 Git 仓库、不开发安装器的前提下，Pi 原生不支持「用一条 GitHub 子目录地址只下载并安装指定插件」。按目录安装需要用本地路径源（方式一）。

## 安装与启用

这个仓库是**插件集合**，不是一个「装上就全用」的单一扩展。设计上仓库只是「存放位置 + 分发渠道」，**每个插件目录都是完整的独立包**，按需单独安装。

当前仓库包含 4 个插件，用 git 源整仓安装会加载全部插件，再用 `pi config` 或过滤列表按需启用：

```bash
pi install git:github.com/Luca4Don3/pi-extensions
```

如果只想装其中几个，用方式一（按目录）或方式二（过滤）。

Pi 的 git 源在源码层面把 `packageRoot` 固定为 clone 目录（`package-manager.js`：`metadata.packageRoot = installedPath`），所以 `pi install git:...` 只能按**仓库**粒度安装；要按**目录**粒度安装，用下面的本地路径源。

### 方式一：克隆后按目录独立安装

```bash
git clone https://github.com/Luca4Don3/pi-extensions ~/pi-extensions

# 只安装需要的插件，每个都是独立的包条目
pi install ~/pi-extensions/extensions/subagent
```

这样 `pi list` / `pi remove` / `pi config` 都以单个插件为粒度，互不影响：

```bash
pi list
# User packages:
#   ~/pi-extensions/extensions/subagent

pi remove ~/pi-extensions/extensions/subagent
```

更新只需要拉取仓库：

```bash
git -C ~/pi-extensions pull
```

本地路径包是「直接读解析后的路径、不复制文件」，所以 `git pull` 后下次启动 Pi 就是新版本，**不需要重新安装**。

### 方式二：整仓安装 + 过滤启用

如果不想自己 clone，也可以用 git 源整仓安装，再用过滤列表决定加载哪些插件：

```bash
pi install git:github.com/Luca4Don3/pi-extensions
```

然后把 `settings.json` 写成对象形式，只列出要启用的插件入口：

```json
{
  "packages": [
    {
      "source": "git:github.com/Luca4Don3/pi-extensions",
      "extensions": [
        "extensions/subagent/index.ts",
        "extensions/pi-token-speed/index.ts"
      ]
    }
  ]
}
```

写成字符串形式会加载 manifest 声明的**全部**插件（当前为 subagent、chinese-prompt、opencode-fallback、pi-token-speed），集合会越来越大，建议一律用对象形式。

```bash
pi update git:github.com/Luca4Don3/pi-extensions
```

`extensions` 数组支持 glob 与排除，例如 `["extensions/*/index.ts", "!extensions/legacy/index.ts"]`；`[]` 表示一个都不加载，`+path` / `-path` 用于精确包含或排除。

### 方式三：单次试跑（不写入任何配置）

```bash
pi -e ~/pi-extensions/extensions/subagent/index.ts
```

## 需要理解的两件事

**查找插件**：直接在 GitHub 仓库里浏览，每个插件一个独立目录。

**启用插件**：Pi **不会**自动阅读仓库并智能挑选插件。它只加载你通过 `settings.json` 启用的扩展。至于什么时候调用 `subagent` 这类工具，由模型根据工具描述和任务自行决定。

## 新增一个插件

1. 创建 `extensions/<name>/index.ts`，默认导出一个接收 `ExtensionAPI` 的工厂函数
2. 创建 `extensions/<name>/package.json`，声明 `pi.extensions: ["./index.ts"]`，让该插件可被单独安装（方式二）
3. 在 `extensions/<name>/tests/` 下补离线测试
4. 根 `package.json` 的 `pi.extensions` 已用 glob（`extensions/*/index.ts`），通常无需改动
5. 提交并推送；本地执行 `pi update` 拉取，再在 `settings.json` 的过滤列表里按需启用

## 版本

根 `package.json` 的版本是集合版本，与各子包版本相互独立：根版本表示仓库整体发布，子包版本记录各插件自身的变更。`extensions/pi-token-speed` 的版本跟随上游收录时保持一致。具体版本号以各目录的 `package.json` 为准。

---

# Subagent

把任务委派给独立上下文的子 agent，避免主上下文被大量探索和试错污染。

## 工作方式

每次调用会 **spawn 一个独立的 `pi` 进程**（`--mode json -p --no-session --no-skills --no-prompt-templates`），解析其 JSON 事件流，把子 agent 的输出压缩后回传主上下文。子 agent 的中间过程不会进入你的上下文。

三种模式：

| 模式 | 参数 | 说明 |
| --- | --- | --- |
| single | `agent` + `task` | 单个子 agent |
| parallel | `tasks[]` | 最多 8 个任务，并发 4 |
| chain | `chain[]` | 顺序执行，用 `{previous}` 注入上一步的压缩输出 |

```json
{ "agent": "scout", "task": "定位 subagent 的 agent 发现逻辑" }
```

```json
{ "chain": [
  { "agent": "scout", "task": "定位相关代码" },
  { "agent": "coder", "task": "按上一步结论修改：{previous}" }
] }
```

其它参数：`agentScope`（`user` / `project` / `both`）、`confirmProjectAgents`、`maxOutputChars`、`maxPreviousChars`、`cwd`、`model`、`thinking`。

模型与思考等级：`model` 接受 `provider/id`，可带 `:thinking` 后缀，用于覆盖本次调用的模型；`thinking` 按任务指定思考等级，优先于模型后缀。两者都可以放在 single 顶层、`tasks[]` 或 `chain[]` 的每一项里。省略时继承主会话模型，思考等级按角色取保守默认（侦查 `low`，其他 `medium`），且任何取值都不得超过主会话当前等级；越界会在启动子进程前显式失败，不会等到链式执行中途才报错。

项目级定义默认需要确认；无交互界面且未获宿主授权时拒绝执行请求中的项目级定义，用户级定义不受影响。

信任边界：`confirmProjectAgents=false` 是**模型可控的工具参数**，只表示“本次调用请求跳过确认”，本身不构成可信授权，也不会建立任何持久信任或白名单。真正跳过项目级确认只能由宿主环境变量授权：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_SUBAGENT_TRUST_PROJECT_AGENTS` | 未设置 | 只接受严格的 `true` / `false`（首尾空白允许），非法值在工具执行开始显式报错且不回显原值。只有显式为 `true` 时，模型传 `confirmProjectAgents:false` 才真正跳过确认 |

未设置或为 `false` 时，模型即使传 `confirmProjectAgents:false` 也按需确认：有 UI 时询问，无 UI 时拒绝，不会被静默放行。模型传 `true` 或省略时行为不变（有 UI 询问、无 UI 拒绝）。

授权值校验发生在启动任何子进程之前，因此“参数模式错误 + 授权值非法”同时出现时会先报配置错误；调用方应先修正环境变量。

执行期固定上限：标准输出单行 1 MiB、标准错误尾部 64 KiB、消息缓存 256 条且总计 2 MiB、工具去重标识 1024 个且单个不超过 4 KiB。缓存淘汰会在结果详情中标记；单行或去重超限会停止进程并明确失败，用量可能不完整。正常退出码为零才视为成功；信号退出记录信号并判为失败。进程退出后只允许排空管道 1 秒，逾期关闭本地管道并报告输出不完整，不将其视为成功。

最终摘要、结果详情和链式上下文合并最后一条含文本的助手消息中的全部合法文本块，忽略思考及工具调用块，再按输出长度限制压缩。

并行模式区分两种失败：普通非零退出或模型错误会保留其他独立任务并收集结果，但整体标记失败；启动异常、输出处理异常或更新回调异常会停止派发新任务，取消运行中的任务，并等待进程及资源收尾后才返回。外部取消同样停止派发并等待收尾。已累计用量保留在结果详情中；取消不能保证服务商撤销已开始的模型推理或费用。

## 配置 agent

子 agent 由 `~/.pi/agent/agents/*.md`（用户级）和 `.pi/agents/*.md`（项目级）定义，frontmatter 支持：

| 字段 | 说明 |
| --- | --- |
| `name` / `description` | 必填，供模型选择 |
| `tools` | 逗号分隔的工具白名单 |
| `model` | 省略则使用宿主默认模型 |
| `maxOutputChars` / `maxPreviousChars` | 回传主上下文的压缩上限 |

仓库自带一套示例定义（scout / planner / coder / reviewer）：

```bash
mkdir -p ~/.pi/agent/agents
cp extensions/subagent/examples/agents/*.md ~/.pi/agent/agents/
```

示例中的 `model` 默认为注释状态（使用宿主默认模型）。要用自己的模型，取消注释并填入 `model: <provider>/<model>:<thinking>`。

## 调用决策

工具的 `description` 与 `promptGuidelines` 会进入系统提示，所以扩展对「何时该委派」给出的是**双向判据**，而不是一味鼓励：

| 该委派 | 自己做 |
| --- | --- |
| 原始输出会淹没上下文、且以后不需要细节（大范围侦查、长命令输出、多文件搜索） | 已知位置的单文件小改 |
| 多个真正独立的调查可以并行 | 答案已在当前上下文里 |
| 需要独立视角的审查 / 规划 | 需要与用户来回确认的步骤 |
| 任务自包含、边界清晰 | 一句话命令 |

成本也写进了描述：每次调用会起一个独立的 `pi` 进程、看不到主对话、返回的是压缩摘要、有启动延迟。指南还明确写了两条反模式——**先理解问题再委派**，以及**不要把 chain 当例行改动的仪式**；摘要不够清楚时要用更窄的任务重跑，而不是猜。

这些判据由测试锁定（`extensions/subagent/tests/mock.test.mjs` 用例 8-11），防止将来退化成单向鼓励。

---

# Chinese Prompt

在每次对话前注入一段中文强约束 system prompt，要求推理与输出全程使用简体中文。

## 用法

装上即生效，无参数、无配置。它通过 `before_agent_start` 事件把规则追加到 system prompt 末尾，不改动其它上下文。不需要时 `pi remove` 即可。

代价说明：它每轮都返回完整 system prompt，对无法表示这种变化的 provider 会让已缓存的前缀失效，从而增加 token 成本；换来的是中文约束进入每一次推理。

---

# OpenCode Fallback

给发往 `opencode.ai` 的请求做两级路由：

1. **固定代理**：GPT / Grok / Muse / Claude 四类模型**始终走代理**，不尝试直连
2. **保守回退**：允许直连的模型只发送一次；仅无正文的安全方法（`GET` / `HEAD` / `OPTIONS`）在明确的建连前错误下允许代理回退

## 为什么这四类必须固定走代理

它们在部分地区会被服务端直接拒绝（`403 RegionError`），直连拿不到结果；而混用直连与代理会让出口 IP 漂移，与 opencode 的会话路由相冲（`MissingSessionID`）。所以对它们不做「直连优先」——**要么代理成功，要么明确失败**。

## 模型识别

| 端点 | 处理 |
| --- | --- |
| `/v1/responses` | 一律固定代理（该端点下当前只有 GPT / Grok / Muse） |
| `/v1/messages` | 读取 `model`，仅已识别的 `minimax-*` / `qwen*` 允许直连；其余、缺失及不可解析模型固定代理 |
| 其它端点 | 直连优先；非安全方法不自动回退 |

正文识别支持字符串、字节数组、二进制大对象（Blob）和请求对象（Request），保留 `init.body` 的覆盖语义。路由解析最多读取 1 MiB，流读取期限为 250 毫秒，且最多读取 16384 个分块；超限、超时、取消或不可克隆的正文在发送前明确失败。失败时尽力取消原正文及读取副本，不无界等待取消。未知正文类型保守走代理，不为模型识别消费其正文。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_OPENCODE_PROXY` | `http://127.0.0.1:7897` | 代理地址 |

## 判定规则

| 情况 | 行为 |
| --- | --- |
| 非 `opencode.ai` 请求 | 原样透传，不附加 dispatcher |
| GPT / Grok / Muse / Claude | 直接走代理，**代理失败也不回退直连** |
| 其他 `opencode.ai` 请求直连成功 | 直接返回 |
| 无正文的安全方法遇到 `ECONNREFUSED` / `EAI_AGAIN` / `ENETUNREACH` / `ENOTFOUND` / `UND_ERR_CONNECT_TIMEOUT` | 改用代理重试一次 |
| `POST` / `PUT` / `PATCH` / `DELETE` 等非安全方法 | 任意错误都直接抛出，不重放 |
| 连接重置、响应头超时、套接字异常、普通超时、未知错误或请求已取消 | 直接抛出，不重试 |

只对 `opencode.ai` 及其子域生效；`opencode.ai.example.com` 这类相似域名不会被误判。

代价说明：代理不可用时，上述四类模型会直接失败。这是「出口不漂移」的必然代价。

---

# Token Speed

在状态栏实时显示模型输出的 tokens-per-second（TPS）、首 token 延迟（TTFT）与 token 统计。本目录收录自上游 [pi-token-speed](https://github.com/gsanhueza/pi-token-speed)，来源、改动与同步方式见 [`extensions/pi-token-speed/UPSTREAM.md`](extensions/pi-token-speed/UPSTREAM.md)。

## 显示内容

| 显示模式 | 说明 |
| --- | --- |
| `tps`（默认） | 只显示实时 TPS，例如 `TPS: 42.0 tok/s` |
| `ttft` | 附加首 token 延迟 |
| `stats` | 附加输出 token 数与耗时 |
| `full` | 同时附加统计与 TTFT |

TPS 按滑动窗口计算，默认窗口 1 秒。四档速度阈值与颜色可在 `/tps` 菜单里调整。首轮流式开始前或空闲时显示 `TPS: --`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/tps` | 打开设置菜单：显示模式、图标、阈值、颜色、滑动窗口、更新间隔 |
| `/tps overrides` | 按 provider 维护覆盖配置 |

## 配置

在 `~/.pi/agent/settings.json` 的 `tokenSpeed` 段配置，全部键可选：

```json
{
  "tokenSpeed": {
    "display": "tps",
    "icon": "⚡",
    "slidingWindow": 1000,
    "updateInterval": 0,
    "useProviderTokens": false,
    "countStrategy": "direct",
    "endTpsBehavior": "average",
    "formatDuration": false,
    "thresholds": { "slow": 0, "medium": 15, "fast": 30, "blazing": 45 },
    "colors": {
      "slow": "#ff4444",
      "medium": "#ffaa00",
      "fast": "#00ff88",
      "blazing": "#44ddff"
    },
    "providerOverrides": {
      "anthropic": { "display": "ttft", "thresholds": { "fast": 60 } }
    }
  }
}
```

- `thresholds` / `colors` / `displayColors` 按档位合并，覆盖单个档位不会清空同组其它值
- `providerOverrides` 按模型的 provider id 匹配，未写的键回落到基础配置
- `display`、`icon`、阈值、颜色、`updateInterval` 在 provider 切换后立即生效；`slidingWindow` 等引擎侧键在下一轮流式开始时生效
- 无效键会在会话开始时以警告提示并回落到默认值

## 说明

- `src/` 与上游 0.12.0 一致，未修改逻辑；入口 `index.ts` 只做转发，使启动列表与 `pi config` 显示 `pi-extensions:pi-token-speed`
- 该目录被根 `tsconfig.json` 排除，不参与本地与 CI 类型检查，运行时由 pi 的 jiti 加载
- 上游同步命令见 `UPSTREAM.md`

# 已迁出的插件

以下两个插件曾在本仓库内维护，现已合并并迁移到 [dsh-web-search](https://github.com/Luca4Don3/dsh-web-search)：

| 原目录 | 现位置 | 说明 |
| --- | --- | --- |
| `extensions/web-search/` | `dsh-web-search`（Pi 宿主） | `web_search` 工具与 `/web-search-auth` 命令 |
| `extensions/web-fetch/` | `dsh-web-search`（Pi 宿主） | `web_fetch` 工具 |

新仓库一份内核同时适配 DSH 与 Pi。工具名与命令保持不变，密钥配置与冷却状态无需迁移，但**不要同时启用新旧两份**：两处都注册 `web_search` / `web_fetch`，会造成工具重名冲突。迁移与卸载步骤见该仓库 README。

## 开发与测试

以下测试覆盖仓库内自研的三个插件（`subagent`、`chinese-prompt`、`opencode-fallback`）；`pi-token-speed` 为上游收录代码，未包含其测试。

```bash
# 离线自动化测试（使用网络与密钥库假实现）
node --test extensions/*/tests/*.test.mjs
```

本地依赖 `jiti` 与 `typebox`，Pi 自带这两个包，指向本机 Pi 安装即可：

```bash
mkdir -p node_modules/@earendil-works
PI_PKG="$(npm root -g)/@earendil-works/pi-coding-agent"
ln -sfn "$PI_PKG/node_modules/jiti" node_modules/jiti
ln -sfn "$PI_PKG/node_modules/typebox" node_modules/typebox
ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent
for p in pi-ai pi-agent-core pi-tui; do
  ln -sfn "$PI_PKG/node_modules/@earendil-works/$p" "node_modules/@earendil-works/$p"
done
```

持续集成（CI）固定安装 `@earendil-works/pi-coding-agent@1.1.0`，在 Node.js 22 与 24 上执行严格类型检查及离线用例。类型检查覆盖扩展源码，测试及示例目录不纳入编译检查；测试由 `npm test` 单独执行。根 `tsconfig.json` 排除了 `extensions/pi-token-speed/**`，因为上游使用 bundler 风格的无扩展名相对导入，与 NodeNext 解析不一致；该目录运行时由 pi 的 jiti 加载，不受影响。持续集成成功不代表真实网络冒烟或安全审计已通过。

本地执行 `npm run typecheck` 前，需安装并链接与工作流一致的 `typescript@5.9.3` 和 `@types/node@22.19.19`：

```bash
npm install -g typescript@5.9.3 @types/node@22.19.19
mkdir -p node_modules/@types
ln -sfn "$(npm root -g)/typescript" node_modules/typescript
ln -sfn "$(npm root -g)/@types/node" node_modules/@types/node
npm run typecheck
```

### 安全门禁边界

完整本地安全审计仍是提交和推送前的独立检查，覆盖工作区、未跟踪文件、暂存对象、全部本地历史及悬空对象、元数据、本地大文件存储对象和已检出的子模块。现有工具的基线、指纹密钥、豁免原因及到期记录必须留在扫描器管理的私有 Git 元数据目录，不提交、不上传为工作流产物。

仓库工作流目前**尚未包含可移植安全扫描或基线到期门禁**，也不声明远端分支保护已启用。后续需独立设计不含敏感原文的持续集成基线，并审核扫描覆盖及误报；不能复制本地私有基线，也不能用测试通过代替安全审计。

## License

本仓库整体采用 MIT，见根目录 [LICENSE](LICENSE)。

### 第三方组件

`extensions/pi-token-speed/` 收录自 [pi-token-speed](https://github.com/gsanhueza/pi-token-speed)，同样采用 MIT，版权归原作者 Gabriel Sanhueza。原始许可证见 [`extensions/pi-token-speed/LICENSE.md`](extensions/pi-token-speed/LICENSE.md)，收录版本、上游提交与改动记录见 [`UPSTREAM.md`](extensions/pi-token-speed/UPSTREAM.md)。
