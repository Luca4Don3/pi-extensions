# Pi Web Search

给 [Pi](https://pi.dev) 补上原生 `web_search` 工具。

Pi 的内置工具只有 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`，联网只能手写 `curl`。这个扩展把搜索变成一个真正的工具调用：模型直接问，扩展负责请求、解析、截断，返回可引用的网页正文与来源链接。

**不依赖 opencode、DSH 或任何额外服务端进程**，也不需要 DeepSeek 官方 API key。只要 Pi 能联网就能用。

> **与 npm 上已有的 `pi-web-search` 的区别**：那个包（作者 ttttmr）走各家 provider 的**服务端原生搜索**能力，需要对应 provider 的 API key；本包直连 Exa / Parallel 的公开 MCP 端点，**无需任何 key，也不挑 provider**。为避开 npm 命名冲突，本包发布为 scoped 名 `@luca4don3/pi-web-search`。

## 特性

- 原生 `web_search` 工具，模型可直接调用，无需再拼 `curl` 命令
- 双后端：Exa（`mcp.exa.ai`）与 Parallel（`search.parallel.ai`）的远程 MCP 端点，默认免 key
- `provider: "auto"` 先试 Exa，失败自动回退 Parallel
- 同时解析直接 JSON 与 SSE（`data:` 帧）两种响应格式
- 25 秒单请求预算，外部取消信号会被转发（Ctrl+C 立即中断）
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

## 可选配置

两个端点默认免 key。若你已有 key，通过环境变量启用更高额度：

| 环境变量 | 作用 |
| --- | --- |
| `EXA_API_KEY` | 以 `?exaApiKey=` 查询参数附加到 Exa 端点 |
| `PARALLEL_API_KEY` | 以 `Authorization: Bearer` 头附加到 Parallel 端点 |

## 工作原理

```text
模型
  → web_search 工具（本扩展注册）
  → JSON-RPC 2.0 tools/call
  → Exa:      https://mcp.exa.ai/mcp           工具 web_search_exa
     或 Parallel: https://search.parallel.ai/mcp  工具 web_search
  → 响应体：直接 JSON 或 SSE 的 data: 帧
  → 归一化为 { content: 正文, sources: [{url,title,snippet,publishedAt}] }
```

Exa 返回的正文本身已是大模型友好的文本布局（`Title:` / `URL:` / `Highlights:`），扩展直接透传并额外抽取结构化来源。Parallel 返回 JSON，扩展转成带链接的 Markdown 列表。

## 开发与测试

`.temp/smoke.mjs` 会 mock Pi 的 `ExtensionAPI`，直接调用 `execute`，不经过模型，覆盖注册、参数校验、真实网络请求、解析与渲染全链路：

```bash
cd pi-web-search
mkdir -p node_modules
ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/jiti" node_modules/jiti
ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/typebox" node_modules/typebox
node .temp/smoke.mjs
```

## 限制与注意

- 依赖 Exa / Parallel 的公开 MCP 端点及其使用条款，非官方集成，端点与配额可能随时变化
- 免 key 通道有速率与额度限制，高频使用请自备 key
- 搜索结果质量由后端决定，扩展只做协议与格式归一化

## License

MIT
