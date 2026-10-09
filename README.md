# Pi Extensions

[![CI](https://github.com/Luca4Don3/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/Luca4Don3/pi-extensions/actions/workflows/ci.yml)

我自己的 [Pi](https://pi.dev) 扩展集合：一个仓库统一管理，一次安装、按需启用、统一更新。

## 包含的扩展

每个插件目录都是**完整独立的 Pi 包**（自带 `package.json`），可以单独安装：

| 插件 | 目录 | 安装 | 作用 |
| --- | --- | --- | --- |
| Web Search | `extensions/web-search/` | `pi install ~/pi-extensions/extensions/web-search` | 原生 `web_search` 工具：Exa / Parallel 免 key 直连，Tavily / SerpApi 配置密钥后参与路由 |
| Subagent | `extensions/subagent/` | `pi install ~/pi-extensions/extensions/subagent` | 把任务委派给独立上下文的子 agent（single / parallel / chain） |
| Chinese Prompt | `extensions/chinese-prompt/` | `pi install ~/pi-extensions/extensions/chinese-prompt` | 注入中文强约束 system prompt，推理与输出全程简体中文 |
| OpenCode Fallback | `extensions/opencode-fallback/` | `pi install ~/pi-extensions/extensions/opencode-fallback` | GPT/Grok/Muse/Claude 固定走代理，其余模型直连优先、失败回退 |

## 仓库结构

```text
pi-extensions/
├── extensions/
│   ├── web-search/
│   │   ├── index.ts              # 扩展入口
│   │   ├── auth.ts               # 凭据解析 / 状态 / 脱敏
│   │   ├── auth-ui.ts            # /web-search-auth 菜单
│   │   ├── credentials.ts        # Keychain / secret-tool 访问层
│   │   ├── package.json          # 让该插件可被单独安装
│   │   └── tests/
│   │       ├── mock.test.mjs     # 离线测试（CI 跑这个）
│   │       ├── auth.test.mjs     # 认证离线测试
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

> **与 npm 上同名包 `pi-web-search` 的区别**：那个包（作者 ttttmr）走各家 provider 的**服务端原生搜索**能力，需要对应 provider 的 API key；本扩展直连 Exa / Parallel 的公开 MCP 端点，**无需任何 key，也不挑 provider**。本扩展不发布到 npm，只通过上面的 GitHub 安装方式分发。

## 状态：v0.4.0-beta.1

已在 **Pi 1.1.0** 上验证，本版本明确承诺：

- Pi 1.1.0 真实会话兼容，模型可自主调用 `web_search`，工具名与参数保持稳定
- 路由：Exa Key → Exa Free → Parallel Key → Parallel Free → Tavily Key → SerpApi Key（未配置密钥的后端自动跳过）
- 额度耗尽（402 / quota 文本）与鉴权失败（401/403）不重试，直接降级到免费通道
- 限流（429）尊重上游 `Retry-After`，5xx 与网络抖动按指数退避重试
- 取消贯穿完整生命周期：请求、响应体读取、退避等待、故障切换、落盘
- MCP `result.isError` 被识别为失败，不会把错误文本当成搜索结果
- `/web-search-auth` 菜单管理凭据：macOS Keychain / Linux secret-tool，环境变量优先，错误文本统一脱敏

**暂不承诺**：匿名端点的无限额度、所有模型（仅在作者本地的一个模型上实测过）、长期运行稳定性。

## 特性

- 原生 `web_search` 工具，模型可直接调用，无需再拼 `curl` 命令
- 双后端：Exa（`mcp.exa.ai`）与 Parallel（`search.parallel.ai`）的远程 MCP 端点，默认免 key
- **Key 优先、失败降级**：配了 key 先走认证通道，额度耗尽或鉴权失败自动改用免费通道，不浪费付费额度
- **凭据可托管给系统密钥库**：`/web-search-auth` 菜单查看状态、生成安全配置命令、删除条目；环境变量优先，macOS Keychain / Linux secret-tool 次之
- `provider: "auto"` 依次尝试 Exa 与 Parallel 的全部可用通道
- 同时解析直接 JSON 与 SSE 事件块（同一事件的多行 `data:` 拼接）
- 单请求预算可注入（默认 25 秒），取消信号贯穿请求、读体、退避、切换与落盘
- 失败分类：额度、限流、鉴权、服务端、网络、超时、取消、协议错误各自决策
- 模型可见正文截断到 24 000 字符，结构化来源与路由信息完整保留在 `details`

## 用法

安装后模型会自行调用。参数由模型生成：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string，必填 | 搜索词。建议描述理想页面，而不是堆关键词 |
| `maxResults` | integer，可选 | 结果条数，默认 `8`，上限 `20` |
| `provider` | `auto` \| `exa` \| `parallel`，可选 | 默认 `auto`：依次尝试 Exa 与 Parallel 的可用通道 |

调用示例：

```json
{ "query": "Pi coding agent extension registerTool API", "maxResults": 5 }
```

也可以直接用文字要求：

```text
用 web_search 查一下 Pi 1.1.0 的扩展 API，给我来源链接。
```

## 配置

以下环境变量均可选，都有默认值（也可以把 key 交给系统密钥库，见下一节）：

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `EXA_API_KEY` | 空 | 以 `?exaApiKey=` 查询参数附加到 Exa 端点；优先于系统密钥库 |
| `PARALLEL_API_KEY` | 空 | 以 `Authorization: Bearer` 头附加到 Parallel 端点；优先于系统密钥库 |
| `TAVILY_API_KEY` | 空 | Tavily 没有免 key 通道；以 `Authorization: Bearer` 头调用 `https://api.tavily.com/search`，固定使用 basic 搜索（1 积分） |
| `SERPAPI_API_KEY` | 空 | SerpApi 没有免 key 通道；以 `api_key` 查询参数调用 `https://serpapi.com/search.json`，结果来自 Google organic_results |
| `PI_WEB_SEARCH_TIMEOUT_MS` | `25000` | 单请求预算，最小 `100` |
| `PI_WEB_SEARCH_RETRIES` | `1` | 可重试错误的最大重试次数，`0` 表示不重试 |

两个端点默认免 key；填 key 只是为了更高额度。

## 认证（`/web-search-auth`）

两个后端都遵循「环境变量优先，系统密钥库其次」：

| 平台 | 系统密钥库 | 配置方式 |
| --- | --- | --- |
| macOS | Keychain | `security add-generic-password` |
| Linux | Secret Service（`secret-tool`） | `secret-tool store` |
| 其它 | 无 | 用外部 secret manager（1Password CLI、Vault、sops、direnv 等）注入进程环境变量，或直接用免 key 通道 |

在 Pi 里执行 `/web-search-auth` 打开 select 菜单：

- **查看状态**：分别报告 exa / parallel 的凭据来源，并区分「未配置」与「系统密钥库不可用」。密钥库读取失败不会阻断搜索，仍会退到免 key 通道。
- **查看配置说明**：输出安全的终端命令，key 只从命令的交互提示读取，**绝不放进命令参数**：

  ```bash
  # macOS
  security add-generic-password -U -a "$USER" -s "pi-web-search-exa" -w
  # Linux
  secret-tool store --label="Pi web search: exa" service pi-web-search provider exa
  ```

- **删除系统密钥库中的密钥**：二次确认后删除对应后端的条目；成功、未找到、失败都有明确诊断。

设计上不在 Pi 的输入框里接收 key（也不使用自定义掩码输入框），密钥写入完全交给系统自带命令，避免 key 进入 Pi 会话、日志或 shell 历史（关键是 `-w` / `store` 后不要跟任何 key 参数）。

> 环境变量始终优先于系统密钥库；每次 `web_search` 只为用到的后端各解析一次凭据，key 仅存在于内存，不进入 `details`、session 或落盘内容；所有对外错误文本（含 URL 编码形式）都会脱敏。

## 搜索路由

一次 `web_search` 会按下面的顺序尝试，成功即停止：

```text
Exa Key  →  Exa Free  →  Parallel Key  →  Parallel Free  →  Tavily Key  →  SerpApi Key
```

没配 key 的后端会跳过对应的 Key 通道。每一步的失败原因决定下一步：

| 失败类型 | 判定 | 处理 |
| --- | --- | --- |
| 额度耗尽 | 402，或错误文本含 quota / credit / balance / insufficient | 不重试，换通道 |
| 鉴权失败 | 401 / 403 | 不重试，换通道 |
| 限流 | 429，或错误文本含 rate limit | 尊重 `Retry-After`，退避重试后换通道 |
| 服务端错误 | 5xx | 退避重试后换通道 |
| 网络抖动 | fetch 抛错（DNS、连接重置等） | 退避重试后换通道 |
| 超时 | 超过 `PI_WEB_SEARCH_TIMEOUT_MS` | 不重试，换通道 |
| 取消 | 调用方中断 | 立即终止，不再发起任何请求 |
| 协议错误 | 其他 4xx、MCP 错误成员、`result.isError`、无可用结果 | 不重试，换通道 |

额度判断完全依赖真实搜索的返回，不会额外发请求探测余额。

## 工作原理

```text
模型
  → web_search 工具（本扩展注册）
  → JSON-RPC 2.0 tools/call
  → Exa:      https://mcp.exa.ai/mcp              工具 web_search_exa
     或 Parallel: https://search.parallel.ai/mcp  工具 web_search
  → 响应体：直接 JSON 或 SSE 的 data: 帧
  → 归一化为 { content: 正文, sources: [{url,title,snippet,publishedAt}] }
```

Exa 返回的正文本身已是大模型友好的文本布局（`Title:` / `URL:` / `Highlights:`），扩展直接透传并额外抽取结构化来源。Parallel 返回 JSON，扩展转成带链接的 Markdown 列表。

## 结果结构

`details` 用于观察这次搜索到底走了哪条通道：

| 字段 | 说明 |
| --- | --- |
| `provider` | 实际命中的后端：`exa` / `parallel` |
| `channel` | 实际命中的通道：`key` / `free` |
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
# 离线测试（83 例）：web-search 27 + web-search auth 23 + opencode-fallback 17 + subagent 16
node --test extensions/*/tests/*.test.mjs

# 真实网络冒烟（会调用 Exa / Parallel，仅 web-search）
node extensions/web-search/tests/smoke.mjs
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

CI（`.github/workflows/ci.yml`）固定安装 `@earendil-works/pi-coding-agent@1.1.0` 后只跑离线用例，用来守住 Pi 兼容性。

## 限制与注意

- 依赖 Exa / Parallel 的公开 MCP 端点及其使用条款，非官方集成，端点与配额可能随时变化
- 免 key 通道有速率与额度限制，高频使用请自备 key；Key 额度耗尽时会自动降级到免 key 通道
- 搜索结果质量由后端决定，扩展只做协议与格式归一化
- 当前只有 `web_search`，没有网页正文抓取工具（`web_fetch`）

## 路线图

- Key 冷却：避免重复请求已确认不可用的认证通道
- `web_fetch`：读取指定 URL 的正文，进一步减少对 `curl` 的依赖
- 结果缓存：减少重复查询
- 更多后端的可插拔注册

## License

MIT
