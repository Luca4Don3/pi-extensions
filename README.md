# Pi Web Search

[![CI](https://github.com/Luca4Don3/pi-web-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Luca4Don3/pi-web-search/actions/workflows/ci.yml)

给 [Pi](https://pi.dev) 补上原生 `web_search` 工具。

Pi 的内置工具只有 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`，联网只能手写 `curl`。这个扩展把搜索变成一个真正的工具调用：模型直接问，扩展负责请求、解析、截断，返回可引用的网页正文与来源链接。

**不依赖 opencode、DSH 或任何额外服务端进程**，也不需要 DeepSeek 官方 API key。只要 Pi 能联网就能用。

> **与 npm 上已有的 `pi-web-search` 的区别**：那个包（作者 ttttmr）走各家 provider 的**服务端原生搜索**能力，需要对应 provider 的 API key；本包直连 Exa / Parallel 的公开 MCP 端点，**无需任何 key，也不挑 provider**。为避开 npm 命名冲突，本包发布为 scoped 名 `@luca4don3/pi-web-search`。

## 状态：v0.2.0-beta.1

已在 **Pi 1.1.0** 上验证，本版本明确承诺：

- Pi 1.1.0 真实会话兼容，模型可自主调用 `web_search`
- Exa / Parallel 搜索可用，`auto` 自动故障切换可用
- 调用方取消与请求超时可用
- 限流（429）与 5xx 会按指数退避重试一次

**暂不承诺**：匿名端点的无限额度、所有模型（仅实测 `deepseek-v4.1-flash`）、长期运行稳定性。

## 特性

- 原生 `web_search` 工具，模型可直接调用，无需再拼 `curl` 命令
- 双后端：Exa（`mcp.exa.ai`）与 Parallel（`search.parallel.ai`）的远程 MCP 端点，默认免 key
- `provider: "auto"` 先试 Exa，失败自动回退 Parallel
- 同时解析直接 JSON 与 SSE（`data:` 帧）两种响应格式
- 单请求预算可注入（默认 25 秒），外部取消信号会被转发（Ctrl+C 立即中断）
- 429 / 5xx / 网络抖动按 `400ms × 2^n` 退避重试，超时与取消不重试
- 模型可见正文截断到 24 000 字符，结构化来源完整保留在 `details`

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
| `maxResults` | number，可选 | 结果条数，默认 `8`，上限 `20` |
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

## 落盘与隐私

正文超过 24 000 字符时，完整内容会落到系统临时目录，供模型按需 `read`：

- 目录：`$TMPDIR/pi-web-search`，权限 `0700`
- 文件：`results-<时间戳>-<随机>.txt`，权限 `0600`
- 单文件上限 2 MB，超出时 `details.fullTextComplete` 为 `false`
- 目录只保留最近 20 个文件，更旧的自动清理
- 仅写入公开网页正文；API key 只出现在请求头或 URL，不进入落盘内容

## 开发与测试

```bash
# 离线测试（16 例：解析、回退、取消、超时、重试、截断、落盘清理）
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
- 免 key 通道有速率与额度限制，高频使用请自备 key
- 搜索结果质量由后端决定，扩展只做协议与格式归一化
- 当前只有 `web_search`，没有网页正文抓取工具（`web_fetch`）

## 路线图

- `web_fetch`：读取指定 URL 的正文，进一步减少对 `curl` 的依赖
- 结果缓存：减少重复查询
- 更多后端的可插拔注册

## License

MIT
