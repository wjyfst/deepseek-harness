# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

由 [Tavily](https://tavily.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它以 bearer 鉴权调用 Tavily 的 `POST /search` 端点，把生成的 `answer` 与 `results[]` 页面摘录映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有密钥，也不注册面向模型的工具。与 `@deepseek-ai/dsh-web-search-exa` 一样，它是函数／命名空间插件（`inject: ['web']`）。Tavily 的协议格式（wire format）是提供方私有细节，不会使该提供方依赖任何其他 seam。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Tavily API 密钥。建议改用 `apiKeyEnv`，让密钥不进入配置文件。 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 凭据引用；每次搜索时通过 credentials 服务解析，seam 未挂载时回退到启动环境。解析不到密钥时每次搜索都会以凭据诊断失败。 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic`（快速）或 `advanced`（深度抓取）。 |
| `maxResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数。未设置时不发送默认值。必须是正整数。 |
| `includeAnswer` | `true` | 是否请求 Tavily 生成的 `answer`（映射到 `content`）。 |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

## 映射

`content` ← `answer`（生成答案，仅当请求了 `include_answer` 时存在）。`sources[]` ← `results[]`：`url` ← `url`、`title` ← `title`、`snippet` ← `content`（页面摘录）、`publishedAt` ← `published_date`；没有可用 URL 的条目会被丢弃，因为 seam 保证每个源都携带 URL。请求的 `maxResults` 优先于已配置的默认 `maxResults`，并作为 Tavily `max_results` 发送，以优化成本和延迟；最终上限由 seam 强制执行（截断 `sources[]` 并设置 `truncated`）。提供方失败（HTTP 错误、网络失败、响应体无法解析或结构不符）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；缺少密钥以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

### 辅助 Tavily 请求

#### 模型看到的内容

独立的 Tavily 流水线在搜索端点原样接收 `<query>`。该请求不属于会话模型上下文。

#### Token 影响

每次搜索在 Tavily 侧消耗 token；发送的 `max_results` 限制检索结果数量。

#### KV Cache 影响

与会话请求缓存相互独立。同一路由下的相同查询可能复用提供方缓存；查询或路由改变会建立不同前缀。

### 间接的会话工具结果

#### 模型看到的内容

通过 [`dsh-tool-web`](../tool-web/README.zh.md)，会话模型会看到生成答案及结构化结果元数据（URL、标题、摘录、发布日期）。该提供方确切的错误消息为 `Tavily search aborted`、`Tavily search request failed: <error>`、`Tavily search credential resolution failed: <error>`、`Tavily search has no API key for "<ref>"`（附存储提示）和 `Tavily returned an unprocessable response body: <error>`；HTTP 失败保留提供方消息。错误包装层属于消费方。

#### Token 影响

注册不会直接产生会话 token。答案与源 token 取决于数据，源数量受服务限制；保留的结果或错误会重复发送，直到发生压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **没有可用 URL 的结果会被整个丢弃**：此类条目不存在可移植引用，因此返回源可能少于请求数量。
- **相关度评分被丢弃**：`score` 是提供方内部排序，seam 没有承载它的字段。
- **只公开 `searchDepth`／`maxResults`／`includeAnswer`**：Tavily 的其他控制项（`topic`、`days`、域名过滤条件、原始内容、图片）有待提供方无关的 Service Definition 字段支持（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
