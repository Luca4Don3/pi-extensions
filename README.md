# Pi Extensions

[![CI](https://github.com/Luca4Don3/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/Luca4Don3/pi-extensions/actions/workflows/ci.yml)

我自己的 [Pi](https://pi.dev) 扩展集合：一个仓库统一管理，一次安装、按需启用、统一更新。

## 包含的扩展

每个插件目录都是**完整独立的 Pi 包**（自带 `package.json`），可以单独安装：

| 插件 | 目录 | 安装 | 作用 |
| --- | --- | --- | --- |
| Web Search | `extensions/web-search/` | `pi install ~/pi-extensions/extensions/web-search` | 原生 `web_search` 工具：Exa → Tavily → Parallel → Firecrawl → TinyFish 匿名路由与额度预检；SerpApi 保留为需显式授权的密钥后端 |
| Subagent | `extensions/subagent/` | `pi install ~/pi-extensions/extensions/subagent` | 把任务委派给独立上下文的子 agent（single / parallel / chain） |
| Chinese Prompt | `extensions/chinese-prompt/` | `pi install ~/pi-extensions/extensions/chinese-prompt` | 注入中文强约束 system prompt，推理与输出全程简体中文 |
| OpenCode Fallback | `extensions/opencode-fallback/` | `pi install ~/pi-extensions/extensions/opencode-fallback` | GPT/Grok/Muse/Claude 固定走代理，其余模型直连优先、失败回退 |

## 仓库结构

```text
pi-extensions/
├── extensions/
│   ├── web-search/
│   │   ├── index.ts              # 扩展入口与搜索执行
│   │   ├── response-body.ts      # 响应体流式解码与字节上限
│   │   ├── search/
│   │   │   ├── registry.ts       # provider ID、环境变量与匿名能力元数据
│   │   │   ├── protocol.ts       # REST provider 共用协议
│   │   │   └── providers/        # Tavily / Firecrawl / SerpApi 独立适配器
│   │   ├── auth.ts               # 凭据解析 / 状态 / 脱敏
│   │   ├── auth-ui.ts            # /web-search-auth 菜单
│   │   ├── credentials.ts        # Keychain / secret-tool 访问层
│   │   ├── channel-health.ts     # 后端与通道独立冷却状态
│   │   ├── quota/                 # 额度预检、成本估算与私有状态持久化
│   │   ├── routing.ts            # 路由与环境变量校验
│   │   ├── search-api.ts         # REST provider 兼容分发层
│   │   ├── masked-input.ts       # 终端掩码输入
│   │   ├── macos-keychain.swift  # macOS 安全框架（Security Framework）写入适配器
│   │   ├── package.json          # 让该插件可被单独安装
│   │   └── tests/
│   │       ├── *.test.mjs        # 离线测试
│   │       └── smoke.mjs         # 真实网络冒烟
│   ├── subagent/
│   │   ├── index.ts              # 工具入口
│   │   ├── agents.ts             # agent 发现逻辑
│   │   ├── examples/agents/      # 示例 agent 定义
│   │   └── tests/mock.test.mjs
│   ├── chinese-prompt/
│   │   ├── index.ts
│   │   └── package.json
│   └── opencode-fallback/
│       ├── index.ts
│       ├── package.json
│       └── tests/mock.test.mjs
├── .github/workflows/ci.yml
├── package.json                  # 根 manifest：pi.extensions 声明所有插件入口
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

Pi 的 git 源在源码层面把 `packageRoot` 固定为 clone 目录（`package-manager.js`：`metadata.packageRoot = installedPath`），所以 `pi install git:...` 只能按**仓库**粒度安装；要按**目录**粒度安装，用下面的本地路径源。

### 方式一：克隆后按目录独立安装（推荐）

```bash
git clone https://github.com/Luca4Don3/pi-extensions ~/pi-extensions

# 只安装需要的插件，每个都是独立的包条目
pi install ~/pi-extensions/extensions/web-search
```

这样 `pi list` / `pi remove` / `pi config` 都以单个插件为粒度，互不影响：

```bash
pi list
# User packages:
#   ~/pi-extensions/extensions/web-search

pi remove ~/pi-extensions/extensions/web-search
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
      "extensions": ["extensions/web-search/index.ts"]
    }
  ]
}
```

写成字符串形式会加载 manifest 声明的**全部**插件，集合会越来越大，建议一律用对象形式。

```bash
pi update git:github.com/Luca4Don3/pi-extensions
```

`extensions` 数组支持 glob 与排除，例如 `["extensions/*/index.ts", "!extensions/legacy/index.ts"]`；`[]` 表示一个都不加载，`+path` / `-path` 用于精确包含或排除。

### 方式三：单次试跑（不写入任何配置）

```bash
pi -e ~/pi-extensions/extensions/web-search/index.ts
```

## 需要理解的两件事

**查找插件**：直接在 GitHub 仓库里浏览，每个插件一个独立目录。

**启用插件**：Pi **不会**自动阅读仓库并智能挑选插件。它只加载你通过 `settings.json` 启用的扩展。至于什么时候调用 `web_search` 这类工具，由模型根据工具描述和任务自行决定。

## 新增一个插件

1. 创建 `extensions/<name>/index.ts`，默认导出一个接收 `ExtensionAPI` 的工厂函数
2. 创建 `extensions/<name>/package.json`，声明 `pi.extensions: ["./index.ts"]`，让该插件可被单独安装（方式二）
3. 在 `extensions/<name>/tests/` 下补离线测试
4. 根 `package.json` 的 `pi.extensions` 已用 glob（`extensions/*/index.ts`），通常无需改动
5. 提交并推送；本地执行 `pi update` 拉取，再在 `settings.json` 的过滤列表里按需启用

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
{ "agent": "scout", "task": "定位 web-search 的来源解析函数" }
```

```json
{ "chain": [
  { "agent": "scout", "task": "定位相关代码" },
  { "agent": "coder", "task": "按上一步结论修改：{previous}" }
] }
```

其它参数：`agentScope`（`user` / `project` / `both`）、`confirmProjectAgents`、`maxOutputChars`、`maxPreviousChars`、`cwd`。

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

---

# OpenCode Fallback

给发往 `opencode.ai` 的请求做两级路由：

1. **固定代理**：GPT / Grok / Muse / Claude 四类模型**始终走代理**，不尝试直连
2. **兜底回退**：其余模型（deepseek / glm / kimi / minimax 等）直连优先，仅连接类失败才回退代理

## 为什么这四类必须固定走代理

它们在部分地区会被服务端直接拒绝（`403 RegionError`），直连拿不到结果；而混用直连与代理会让出口 IP 漂移，与 opencode 的会话路由相冲（`MissingSessionID`）。所以对它们不做「直连优先」——**要么代理成功，要么明确失败**。

## 模型识别

| 端点 | 处理 |
| --- | --- |
| `/v1/responses` | 一律固定代理（该端点下当前只有 GPT / Grok / Muse） |
| `/v1/messages` | 读请求体的 `model`，仅 `claude-*` 固定代理（同一端点还混有 minimax / qwen，不能只看端点） |
| 其它端点 | 直连优先，连接失败回退代理 |

请求体不可解析时（非 JSON 字符串），`/v1/messages` 不会被强制代理，避免误伤。

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
| 其他请求直连报连接类错误（`ECONNREFUSED` / `ECONNRESET` / `ENOTFOUND` / `ETIMEDOUT` / `UND_ERR_*` 等） | 改用代理重试一次 |
| 非连接类错误、请求已取消 | 直接抛出，不重试 |

只对 `opencode.ai` 及其子域生效；`opencode.ai.example.com` 这类相似域名不会被误判。

代价说明：代理不可用时，上述四类模型会直接失败。这是「出口不漂移」的必然代价。

---

# Web Search

给 Pi 补上原生 `web_search` 工具。

Pi 的内置工具只有 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`，联网只能手写 `curl`。这个扩展把搜索变成一个真正的工具调用：模型直接问，扩展负责请求、解析、截断，返回可引用的网页正文与来源链接。

**不依赖 opencode、DSH 或任何额外服务端进程**，也不需要 DeepSeek 官方 API key。只要 Pi 能联网就能用。

> **与 npm 上同名包 `pi-web-search` 的区别**：本扩展直接连接 Exa / Parallel 的远程模型上下文协议（Model Context Protocol，MCP）端点，并通过原生 REST 接口调用 Tavily、Firecrawl 与 SerpApi。本扩展不发布到 npm，只通过上面的 GitHub 安装方式分发。

## 状态：v0.6.0-beta.3

本轮新增混合额度管理（Quota Manager）与按原因区分的持久冷却，并把匿名候选顺序调整为 **Exa → Tavily → Parallel → Firecrawl → TinyFish（keyless）**；计费候选顺序独立维护，Exa 仍排第一。仍然不新增搜索 provider、不做质量评分或结果融合，也不添加 `web_fetch`。

**TinyFish 只接入零凭据 keyless 匿名通道。** 该通道位于 MCP 端点，不需要任何 API Key 或 OAuth，服务端自述限额为 30 请求/分钟、每日 50 次搜索。官方文档对其认证通道「超出每日额度后是否扣减钱包余额」的说法相互矛盾且无法验证，因此本轮不实现认证通道，也不把配置 `TINYFISH_API_KEY` 视为免费。

`web_search` 工具名、Pi 安装方式和 `/web-search-auth` 命令保持不变。既有功能说明：

- 默认匿名候选顺序为 **Exa → Tavily → Parallel → Firecrawl → TinyFish（keyless）**；依次尝试并在首个可用结果处返回。该顺序是本项目的路由候选顺序，不是服务质量排行榜。
- SerpApi（不是 Serper）仍是仅密钥的 provider；所有密钥通道都按可能计费处理，默认关闭。授权后的计费候选顺序为 **Exa → Tavily → Parallel → Firecrawl → SerpApi**，与匿名顺序互相独立，便于以后各自调整；TinyFish 只出现在匿名顺序中。
- 授权计费与 `PI_WEB_SEARCH_ROUTING=key-first` 同时设置会显式报错并提示改用 `free-first`；未授权时 `key-first` 仅保留匿名兼容。免费通道永远先于密钥通道尝试。
- `search/registry.ts` 集中维护 provider ID、环境变量名、匿名顺序与计费顺序；REST 适配已拆分为 `search/providers/tavily.ts`、`firecrawl.ts`、`serpapi.ts`，共用 `search/protocol.ts`。这不表示 MCP 已整体迁移，也不表示已完成质量检查、quality-first、RRF、benchmark 或 Key fingerprint。
- `/web-search-auth` 覆盖五个 provider。四家匿名通道及 `auto` 已通过真实网络冒烟；实际 Pi `1.1.0` 终端已通过掩码输入、模拟密钥写入、共享冷却展示与跳过验收。真实系统密钥库的写入、更新及删除仍未实测。
- HTTP 成功不等于搜索成功：失败标记、额度提示、非法结果结构或无有效来源不会作为结果返回。相关性、数量不足与新鲜度的质量策略留待下一轮；当前仍在首个结构有效的结果处返回。

匿名顺序是候选而非排行榜；Artificial Analysis 的 Search API methodology 见 [方法说明](https://artificialanalysis.ai/methodology/search-api)。不声称已复现其截至 2026-09-28 的具体分数。

## 特性

- 原生 `web_search` 工具，模型可直接调用，无需再拼 `curl` 命令
- Exa、Tavily、Parallel、Firecrawl 提供匿名通道，TinyFish 提供零凭据 keyless 匿名通道；SerpApi 仅有密钥通道。默认匿名顺序为 Exa → Tavily → Parallel → Firecrawl → TinyFish
- 计费通道默认禁用；即使环境或系统密钥库中已有密钥，也不会因此获得授权
- 额度预检：Tavily 与 Firecrawl 官方余额接口只回答“当前账户还有多少积分”，不证明账户免费；所有已配置密钥一律视为可能计费
- 系统密钥库由 `/web-search-auth` 菜单管理；环境变量优先，不修改 shell 启动文件
- 同时解析直接 JSON 与服务端发送事件（Server-Sent Events，SSE）数据帧
- 单请求预算默认 25 秒；密钥库读取、请求、读体和退避可中断，切换与落盘前后检查取消；在途文件操作须完成后才返回取消
- 失败分类分别处理额度、限流、鉴权、服务端、网络、超时、取消与协议错误
- HTTP 响应体按实际交付的解压后字节累计，默认上限 5 MiB；成功、错误及分块传输均受限，不信任 `Content-Length`
- 模型可见正文截断到 24 000 字符，结构化来源与路由信息完整保留在 `details`

## 用法

安装后模型会自行调用。参数由模型生成：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string，必填 | 搜索词。建议描述理想页面，而不是堆关键词 |
| `maxResults` | integer，可选 | 结果条数，默认 `8`，上限 `20` |
| `provider` | `auto` \| `parallel` \| `exa` \| `tavily` \| `firecrawl` \| `serpapi`，可选 | 默认 `auto`；显式指定时只尝试该后端获准且可用的通道 |

调用示例：

```json
{ "query": "Pi coding agent extension registerTool API", "maxResults": 5 }
```

也可以直接用文字要求：

```text
用 web_search 查一下 Pi 1.1.0 的扩展 API，给我来源链接。
```

## 配置

环境变量可选；密钥也可交给系统密钥库（见下一节）。配置密钥不等于允许使用密钥：

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `EXA_API_KEY` | 空 | Exa 计费通道凭据；获授权后放入 `exaApiKey` 查询参数；优先于系统密钥库 |
| `PARALLEL_API_KEY` | 空 | Parallel 计费通道凭据；获授权后放入 `Authorization: Bearer` 头；优先于系统密钥库 |
| `TAVILY_API_KEY` | 空 | Tavily 计费通道凭据；获授权后使用 Bearer 头。匿名请求使用 `X-Tavily-Access-Mode: keyless`，两种认证方式不混用；见 [Tavily keyless 文档](https://docs.tavily.com/documentation/keyless) |
| `FIRECRAWL_API_KEY` | 空 | Firecrawl 计费通道凭据；获授权后使用 Bearer 头。匿名搜索不发送 `Authorization`；请求 `https://api.firecrawl.dev/v2/search`，仅传 `sources: ["web"]`，不使用 `scrapeOptions` 或 `categories`；本轮不启用 dev mode |
| `SERPAPI_API_KEY` | 空 | SerpApi 计费凭据；获授权后以 `api_key` 参数请求 `https://serpapi.com/search.json`，解析 Google `organic_results`；不是 Serper |
| `PI_WEB_SEARCH_ROUTING` | `free-first` | 免费优先；未授权时兼容 `key-first`，仍仅使用匿名通道。已授权时 `key-first` 与免费优先冲突，必须迁移为 `free-first`；非法值报错 |
| `PI_WEB_SEARCH_ALLOW_BILLABLE` | `false` | 只接受严格的 `true` 或 `false`；只有显式 `true` 才授权可能计费的密钥通道 |
| `PI_WEB_SEARCH_ALLOW_PAID` | 未设置 | 旧开关兼容别名，只接受严格的 `true` 或 `false`；单独显式设为 `true` 仍可授权。与新开关同时设置且取值不同会报错；非法值报错 |
| `PI_WEB_SEARCH_FREE_COOLDOWN_MS` | 未设置 | 显式设置时作为固定冷却覆盖全部通道；接受 `0` 至 `86400000` 的安全整数，`0` 禁用冷却，非法值报错。未设置时按原因阶梯退避（见下） |
| `PI_WEB_SEARCH_MAX_RESPONSE_BYTES` | `5242880` | 解压后响应体上限，默认 5 MiB；只接受十进制正整数 `1` 至 `20971520`（20 MiB），首尾空白允许，非法配置在读取凭据或请求前报错 |
| `PI_WEB_SEARCH_TIMEOUT_MS` | `25000` | 单次请求预算，最小 `100` 毫秒 |
| `PI_WEB_SEARCH_RETRIES` | `1` | 可重试错误的重试次数，`0` 表示不重试；单次退避等待最多 5 秒 |

默认拒绝所有密钥通道时，搜索不会读取任何 provider 密钥环境变量或系统密钥库。所有已配置密钥均按可能计费处理；本轮只查询余额，不从余额推断免费资格，也不构造 `free-key` 通道。Firecrawl 请求与计费说明见[搜索文档](https://docs.firecrawl.dev/features/search)和[计费文档](https://docs.firecrawl.dev/billing)。

## 认证（`/web-search-auth`）

五个后端均遵循「环境变量优先，系统密钥库其次」。环境变量不会被菜单修改，也不会写入 shell 启动文件（shell startup file）。

| 平台 | 系统密钥库 | 写入方式 |
| --- | --- | --- |
| macOS | Keychain | 静态 `macos-keychain.swift` 通过标准输入（standard input）调用安全框架（Security Framework）；`security` 命令仅用于读取和删除 |
| Linux | Secret Service（`secret-tool`） | 密钥通过标准输入交给 `secret-tool`，写入后重新读取验证 |
| 其它 | 无 | 可通过外部密钥管理工具向进程注入环境变量；不会退化为明文文件 |

在 Pi 里执行 `/web-search-auth` 打开菜单：

- **查看状态**：报告 Exa、Parallel、Tavily、Firecrawl、SerpApi 五个后端的密钥来源，并区分未配置与系统密钥库不可用。
- **添加或修改密钥**：仅在终端交互界面（Terminal UI，TUI）且 `ctx.ui.custom` 可用时显示自绘掩码输入；接受 1–4096 个非空白美国信息交换标准代码（American Standard Code for Information Interchange，ASCII）可打印字符（printable ASCII）。超长、空白或控制字符输入（含粘贴）整体拒绝，不截断，也不使用明文输入回退。取消确认或输入均不会写入。
- **查看路由与冷却状态**：显示路由策略、密钥通道开关、各后端 / 通道的剩余冷却与下次探测时间、额度状态持久化情况；不发起任何余额查询，也不展示凭据指纹。
- **查看配置说明**：为当前平台提供不含密钥值的安全说明，不要求把密钥写进命令或参数。
- **删除系统密钥库中的密钥**：选择后需二次确认；取消不会写入或删除任何凭据。

macOS 写入实现使用静态 Swift 适配器与系统安全框架，密钥经标准输入传递；实现包含写入后读回验证，但真实系统 Keychain 写入尚未实测。Linux 写入同样经标准输入传递并在完成后读回比对。菜单的掩码组件依赖 Pi 自带的 `@earendil-works/pi-tui`，无需单独安装。

> 未显式允许计费时，搜索不读取密钥环境变量或系统密钥库；授权后才在路由前一次解析全部所需凭据。密钥仅在内存和请求所需位置使用，不进入 `details`、session 或落盘内容。对外错误文本（含 URL 编码形式）和结果回显都会脱敏。

## 搜索路由

未显式授权计费时，自动路由只走匿名通道；已授权时同样先尝试完全部匿名通道，才进入计费候选。两类顺序互相独立维护：

```text
匿名候选：Exa → Tavily → Parallel → Firecrawl → TinyFish（keyless）
计费候选：Exa → Tavily → Parallel → Firecrawl → SerpApi
```

到首个可用结果即返回。显式 provider 只选择该 provider；SerpApi 没有匿名通道。授权后仍先用匿名通道；只有匿名候选都不可用，才按计费候选顺序逐个尝试已配置密钥。启用 `PI_WEB_SEARCH_ALLOW_BILLABLE=true` 时如果再设置 `PI_WEB_SEARCH_ROUTING=key-first`，会直接报错并提示改用 `free-first`，而不是静默降低免费优先级。新开关与旧别名同时设置且取值不同，或任一开关不是严格的 `true` / `false`，同样报错。密钥存在与否不能推断余额或免费资格；本轮仍不提供 `free-key` 分类。

### 额度预检

在发送任何密钥搜索前，授权工具会按后端类型判断：

| 后端 | 是否查询余额 | 依据 |
| --- | --- | --- |
| Tavily | 是 | `GET https://api.tavily.com/usage`，取 `key.usage/limit` 与账户计划 + 按量余额的最小可用量 |
| Firecrawl | 是 | `GET https://api.firecrawl.dev/v2/team/credit-usage`，取 `data.remainingCredits` |
| Exa、Parallel、SerpApi | 否 | 没有可用的公开余额接口，只依据历史冷却状态 |
| TinyFish | 否 | keyless 匿名通道没有账户与余额概念；限额由服务端强制，只依据历史冷却状态 |

查询结果缓存 5 分钟，失败短缓存 30 秒，同凭据并发只发起一次查询。单次搜索预估成本：Tavily 基础搜索（basic）固定 1 积分；Firecrawl `sources: ["web"]` 每开始的 10 条结果 2 积分。余额不足或额度未知时不发送搜索请求，并记为 `quota_preflight` 失败，不计入搜索尝试次数。正余额仅不足以支付一次较昂贵请求时，不记录额度耗尽冷却，后续较便宜请求仍可执行；已知零余额或额度接口明确限流会记录对应冷却。请求一旦发出就按预估成本记账，超时、取消、正文超限都不返还，保守降低超额风险。

重要边界：`key.limit` 为 `null` 只表示该 Key 没有单独上限，账户仍按计划与按量余额计算；两个接口都没有字段能证明账户是免费计划或已关闭按量计费。因此**余额大于零不等于免费**，所有密钥通道仍按可能计费处理。也没有名为 reset 的字段，冷却到期不代表额度已恢复。

### 冷却与额度状态

冷却按服务商、通道和凭据分别隔离，使用带本地随机盐的哈希消息认证码（HMAC）标识作用域；进程内即时生效，并在 Pi 配置目录 `config/web-search/` 下持久化（目录 `0700`、文件 `0600`，保存随机盐、作用域标识与冷却元数据，不保存密钥、查询内容或账户标识）。首次运行会逐级创建缺失的私有配置目录，拒绝符号链接或非目录祖先，不改变已有目录权限或覆盖已有文件。重启后已冷却通道仍被跳过；再次成功会清除历史。持久化失败时搜索继续，只在 `details.quotaWarning` 暴露固定诊断。

- 临时限流：优先 `Retry-After`（支持秒与 HTTP 日期，上限 24 小时），否则 1、2、5、10、30 分钟递进。
- 额度耗尽：优先服务商明确的重置时间；当前适配器没有此证据，因此按 30 分钟、1 小时、2 小时、4 小时作为下一探测间隔，不等于额度恢复时间。
- HTTP 429 只发送一次搜索即切换通道并冷却，不再对同一通道短暂重试；服务端错误与可重试网络错误仍按原规则重试。
- 同一实例内并发搜索按顺序原子预留；跨进程或同一账户被其他客户端使用时，本地预留不构成全局硬上限，需要在服务商侧设置费用上限。

Exa 匿名 MCP 响应中精确额度提示 `You've hit Exa's free MCP rate limit` 会归为额度耗尽，不会作为结果返回。原有重试默认 1 次，单次退避等待最多 5 秒；取消立即终止且不记录为失败，普通网络错误不触发冷却。

额度提示可能带注册链接，因此必须在提取来源前识别，不能因为存在链接就认定为搜索成功。当前 Exa 规则依赖已知提示的正文开头；若正常正文恰以完全相同的提示开头，仍可能误判。此边界尚未消除，需要以真实响应夹具继续收紧，而不是将额度识别移到「无链接」判断之后。

| 失败类型 | 处理 |
| --- | --- |
| `quota_preflight` | 冷却、余额不足或额度未知时跳过搜索，不计入搜索尝试次数；已知零余额或查询限流会记录对应冷却 |
| 额度耗尽、鉴权失败 | 不重试，尝试下一路由通道；额度耗尽记录冷却，鉴权失效冷却暂未实现 |
| HTTP 429 | 有界正文未超限时，只发送一次搜索，切换通道并按 `Retry-After` 或阶梯冷却；明确额度耗尽则记录耗尽冷却 |
| 服务端错误、可重试网络错误 | 按 `PI_WEB_SEARCH_RETRIES` 重试，之后尝试下一通道 |
| 超时、协议错误、无可用结果 | 不重试，尝试下一通道 |
| `response_too_large` | 立即中止底层请求并取消读取；不重试当前通道、不记录冷却，按原路由尝试下一通道 |
| 取消 | 立即终止，不再发请求，也不记录冷却 |

### 响应体资源上限

`response-body.ts` 按流累计 `Uint8Array.byteLength`，再增量解码 UTF-8；恰好达到上限允许返回，超过上限立即终止底层 HTTP 请求。正常响应与 HTTP 429、500 等错误正文共用此限制；即使错误响应带有限流状态，正文超限也归为 `response_too_large`，不触发重试或额度冷却。解码保持跨数据块的中文字符完整。

在 Node.js 内置 `fetch` 的正常自动解压流程下，统计的是流交付的解压后字节，而不是 gzip 压缩体积。超限不会返回部分搜索结果；`Content-Length` 缺失、伪造或代表压缩体积时也不能绕过限制。外部取消与原有单请求超时保持各自语义；外部取消立即终止全部路由，超时仍按原策略切换下一通道。默认禁止计费的规则不变。

**5 MiB 仅是响应体有效载荷的字节上限，不是 JavaScript 进程整体内存的绝对上限。** 字符串解码、JSON 解析和结构化来源仍有额外开销。它也不同于原有的 24 000 字符模型正文上限与 2 MiB 落盘上限：三者分别限制网络正文、模型上下文和磁盘写入。

本修复的解压、边界与中断验收使用本地 HTTP 测试服务器，不发起厂商搜索；前文四家匿名通道与终端验证记录来自 `v0.5.0-beta.1`。

匿名候选顺序不是质量排名；当前不做质量不足后的跨 provider 选择，质量感知路由留待后续路线图。

## 工作原理

```text
模型
  → web_search 工具（本扩展注册）
  → Exa / Parallel：JSON-RPC 2.0 tools/call，连接远程 MCP 端点
  → Tavily / Firecrawl / SerpApi：各自独立的原生 REST 适配器，共用 search/protocol.ts
  → MCP 响应：直接 JSON 或 SSE 的 data: 帧；REST 响应：JSON
  → 归一化为 { content: 正文, sources: [{url,title,snippet,publishedAt}] }
```

Exa 返回的正文采用大模型友好的文本布局（`Title:` / `URL:` / `Highlights:`），扩展直接透传并额外抽取结构化来源。Parallel、Tavily、Firecrawl 与 SerpApi 的响应会归一化为带链接的搜索结果。

## 结果结构

`details` 用于观察这次搜索到底走了哪条通道：

| 字段 | 说明 |
| --- | --- |
| `provider` | 实际命中的后端：`exa` / `parallel` / `tavily` / `firecrawl` / `serpapi` |
| `channel` | 兼容保留的通道标签：`free` / `key` |
| `accessTier` | 访问层级：`anonymous` / `billable` |
| `sourceCount` | 结构化来源条数（不超过 `maxResults`） |
| `sources` | `[{ url, title, snippet, publishedAt }]` |
| `truncated` | 模型可见正文是否被截断 |
| `fullTextPath` | 截断时完整正文的落盘路径 |
| `fullTextComplete` | 落盘内容是否完整（受 2 MB 上限约束） |
| `attemptCount` | 本次搜索实际发出的请求次数 |
| `fallbackReason` | 发生降级时的链路说明，如 `exa(key)[quota_exhausted]: ...` |

## 落盘与隐私

正文超过 24 000 字符时，完整内容会落到系统临时目录，供模型按需 `read`：

- 目录：`$TMPDIR/pi-web-search`，权限 `0700`
- 文件：`results-<时间戳>-<随机>.txt`，权限 `0600`
- 单文件上限 2 MB，超出时 `details.fullTextComplete` 为 `false`
- 目录只保留最近 20 个文件，更旧的自动清理
- 仅写入公开网页正文；API key 只在内存与请求头 / URL 中，不进入落盘内容，也不会出现在错误文本里
- 上游响应回显 key（正文、来源 URL 或错误文本）时，`content`、`details` 与落盘内容都会先脱敏再截断

## 开发与测试

以下测试覆盖仓库内**所有**插件：

```bash
# 离线自动化测试（使用网络与密钥库假实现）
node --test extensions/*/tests/*.test.mjs

# 全部匿名 provider 与 auto 的真实网络冒烟（默认强制匿名、不读密钥、不访问真实密钥库）
node extensions/web-search/tests/smoke.mjs

# 仅当环境路由配置已显式允许计费时才可运行；可能产生费用，不要把密钥放入命令参数
node extensions/web-search/tests/smoke.mjs --billable
```

普通冒烟脚本（smoke）会强制 `PI_WEB_SEARCH_ALLOW_BILLABLE=false` 并清除旧别名；`--billable` 还要求当前配置已明确授权且不存在路由冲突，运行时仍匿名优先，仅允许在匿名失败后计费回退，可能产生费用且不会打印密钥值。四家匿名通道及 `auto` 在 `v0.5.0-beta.1` 已通过一次真实网络冒烟；`v0.6.0-beta.3` 又对 TinyFish keyless 单独冒烟一次并确认零凭据。这些只验证端点可用性，不代表质量排名或长期成功率。离线语法检查可用 `node --check extensions/web-search/tests/smoke.mjs`，不触网；任何离线测试都不代表真实系统 Keychain 写入已验证。本地依赖 `jiti` 与 `typebox`，Pi 自带这两个包，指向本机 Pi 安装即可：

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

CI（`.github/workflows/ci.yml`）固定安装 `@earendil-works/pi-coding-agent@1.1.0` 后只跑离线用例，用来守住 Pi 兼容性。

## 限制与注意

- 依赖 Exa / Parallel 的公开 MCP 端点及其使用条款，非官方集成，端点与配额可能随时变化
- 匿名通道有速率与额度限制；已配置 Key 一律视为可能计费，余额接口不能证明账户免费
- Tavily 与 Firecrawl 的额度查询只用于判断“本次是否付得起”，不代表免费额度；Exa、Parallel、SerpApi 没有可用余额接口，只依据历史冷却
- 额度状态持久化只保存作用域标识与冷却元数据；本地请求计数无法覆盖同一账户的其他客户端，也不替代服务商侧的账单与硬性费用上限
- 搜索结果质量由后端决定；当前首个可用结果即返回，不实施 quality-first 或质量不足后的跨 provider 决策
- 当前只有 `web_search`，没有网页正文抓取工具（`web_fetch`）

## 路线图

- 免费认证层：仅在能验证账户不会超额计费时，才把免费账户密钥纳入免费候选池；当前余额接口不足以证明，暂不启用
- 质量感知的跨 provider 后备策略；评估 RRF 与 benchmark 前先明确方法和复现条件，目前均未实现
- `web_fetch`：读取指定 URL 的正文，进一步减少对 `curl` 的依赖
- 结果缓存与进一步的 provider 模块整理；本轮并非完整 MCP 模块迁移
- TinyFish 认证通道暂缓：其 API Reference 的 Billing 段写「每日 12,000 次后需要钱包正余额，否则 402」，而定价页与公告写「Search 永不扣钱包、$0 余额仍可用」，两处口径矛盾且无法验证。keyless 匿名通道没有账户，因此不存在扣费风险，本轮只接入它。见 [Search API Reference](https://docs.tinyfish.ai/search-api/reference) 与 [Pricing](https://www.tinyfish.ai/pricing)。
- TinyFish keyless 限额小且可能为共享池：服务端自述 30 请求/分钟、每日 50 次搜索，其他 keyless 客户端会消耗同一额度。它排在匿名候选最后，仅作补充；冷却只能跳过本机已知被限流的时刻，不能反映真实剩余额度。
- 认证失效冷却：针对 401 / 403 等失效密钥，避免重复请求；429 通道冷却已实现
- 每日 / 每月预算与费用上限提示，以及真实系统密钥库与实际账户的端到端验证

## License

MIT
