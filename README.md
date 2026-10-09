# Pi Web Search

[![CI](https://github.com/Luca4Don3/pi-web-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Luca4Don3/pi-web-search/actions/workflows/ci.yml)

给 [Pi](https://pi.dev) 补上原生 `web_search` 工具。

Pi 的内置工具只有 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`，联网只能手写 `curl`。这个扩展把搜索变成一个真正的工具调用：模型直接问，扩展负责请求、解析、截断，返回可引用的网页正文与来源链接。

**不依赖 opencode、DSH 或任何额外服务端进程**，也不需要 DeepSeek 官方 API key。只要 Pi 能联网就能用。

> **与 npm 上已有的 `pi-web-search` 的区别**：那个包（作者 ttttmr）走各家 provider 的**服务端原生搜索**能力，需要对应 provider 的 API key；本包直连 Exa / Parallel 的公开 MCP 端点，**无需任何 key，也不挑 provider**。为避开 npm 命名冲突，本包发布为 scoped 名 `@luca4don3/pi-web-search`。

## 状态：v0.3.0-beta.1

已在 **Pi 1.1.0** 上验证，本版本明确承诺：

- Pi 1.1.0 真实会话兼容，模型可自主调用 `web_search`，工具名与参数保持稳定
- 四通道路由：Exa Key → Exa Free → Parallel Key → Parallel Free
- 额度耗尽（402 / quota 文本）与鉴权失败（401/403）不重试，直接降级到免费通道
- 限流（429）尊重上游 `Retry-After`，5xx 与网络抖动按指数退避重试
- 取消贯穿完整生命周期：请求、响应体读取、退避等待、故障切换、落盘
- MCP `result.isError` 被识别为失败，不会把错误文本当成搜索结果

**暂不承诺**：匿名端点的无限额度、所有模型（仅实测 `deepseek-v4.1-flash`）、长期运行稳定性。

## 特性

- 原生 `web_search` 工具，模型可直接调用，无需再拼 `curl` 命令
- 双后端：Exa（`mcp.exa.ai`）与 Parallel（`search.parallel.ai`）的远程 MCP 端点，默认免 key
- **Key 优先、失败降级**：配了 key 先走认证通道，额度耗尽或鉴权失败自动改用免费通道，不浪费付费额度
- `provider: "auto"` 依次尝试 Exa 与 Parallel 的全部可用通道
- 同时解析直接 JSON 与 SSE 事件块（同一事件的多行 `data:` 拼接）
- 单请求预算可注入（默认 25 秒），取消信号贯穿请求、读体、退避、切换与落盘
- 失败分类：额度、限流、鉴权、服务端、网络、超时、取消、协议错误各自决策
- 模型可见正文截断到 24 000 字符，结构化来源与路由信息完整保留在 `details`

## 安装

### 方式一：单次试跑

```bash
pi -e <path>/pi-web-search/index.ts
```

### 方式二：写进配置（推荐）

在 `~/.pi/agent/settings.json` 的 `extensions` 数组里加上扩展路径：

```json
{
  "extensions": ["<path>/pi-web-search/index.ts"]
}
```

### 方式三：作为 Pi 包安装

```bash
pi install npm:@luca4don3/pi-web-search
# 或直接从源码
pi install git:github.com/Luca4Don3/pi-web-search
```

## 用法

安装后模型会自行调用。参数由模型生成：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string，必填 | 搜索词。建议描述理想页面，而不是堆关键词 |
| `maxResults` | integer，可选 | 结果条数，默认 `8`，上限 `20` |
| `provider` | `auto` \| `exa` \| `parallel`，可选 | 默认 `auto`：先试 Exa，失败回退 Parallel |

调用示例：

```json
{ "query": "Pi coding agent extension registerTool API", "maxResults": 5 }
```

也可以直接用文字要求：

```text
用 web_search 查一下 Pi 1.1.0 的扩展 API，给我来源链接。
```

## 配置

全部通过环境变量，均有默认值：

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `EXA_API_KEY` | 空 | 以 `?exaApiKey=` 查询参数附加到 Exa 端点 |
| `PARALLEL_API_KEY` | 空 | 以 `Authorization: Bearer` 头附加到 Parallel 端点 |
| `PI_WEB_SEARCH_TIMEOUT_MS` | `25000` | 单请求预算，最小 `100` |
| `PI_WEB_SEARCH_RETRIES` | `1` | 可重试错误的最大重试次数，`0` 表示不重试 |

两个端点默认免 key；填 key 只是为了更高额度。

## 搜索路由

一次 `web_search` 会按下面的顺序尝试，成功即停止：

```text
Exa Key  →  Exa Free  →  Parallel Key  →  Parallel Free
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
- 仅写入公开网页正文；API key 只出现在请求头或 URL，不进入落盘内容

## 开发与测试

```bash
# 离线测试（27 例：解析、四通道路由、额度/鉴权降级、取消、超时、重试、正则回归、截断、落盘清理）
node --test tests/mock.test.mjs

# 真实网络冒烟（会调用 Exa / Parallel）
node tests/smoke.mjs
```

本地依赖 `jiti` 与 `typebox`，Pi 自带这两个包，指向本机 Pi 安装即可：

```bash
mkdir -p node_modules
ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/jiti" node_modules/jiti
ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/typebox" node_modules/typebox
```

CI（`.github/workflows/ci.yml`）固定安装 `@earendil-works/pi-coding-agent@1.1.0` 后只跑离线用例，用来守住 Pi 兼容性。

## 限制与注意

- 依赖 Exa / Parallel 的公开 MCP 端点及其使用条款，非官方集成，端点与配额可能随时变化
- 免 key 通道有速率与额度限制，高频使用请自备 key；Key 额度耗尽时会自动降级到免 key 通道
- 搜索结果质量由后端决定，扩展只做协议与格式归一化
- 当前只有 `web_search`，没有网页正文抓取工具（`web_fetch`）

## 路线图

- `web_fetch`：读取指定 URL 的正文，进一步减少对 `curl` 的依赖
- 结果缓存：减少重复查询
- 更多后端的可插拔注册

## License

MIT
