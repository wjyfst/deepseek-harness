# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

A [Tavily](https://tavily.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Tavily's `POST /search` endpoint with bearer auth and maps the generated `answer` plus the `results[]` page excerpts into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. Like `@deepseek-ai/dsh-web-search-exa`, it is a function/namespace plugin (`inject: ['web']`). The Tavily wire shape is a provider-private detail — it does not make this provider depend on any other seam.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Tavily API key. Prefer `apiKeyEnv` so no secret enters configuration files. |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved per search through the credentials service, with a launch-environment fallback when the seam is unmounted. No resolved key makes each search fail with a credential diagnostic. |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily's `search_depth`: `basic` (fast) or `advanced` (deeper crawl). |
| `maxResults` | (unset) | Default result count when a request carries no `maxResults`. Unset sends no default. Must be a positive integer. |
| `includeAnswer` | `true` | Request Tavily's generated `answer` (mapped to `content`). |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

## Mapping

`content` ← `answer` (the generated answer, present when `include_answer` was requested). `sources[]` ← `results[]`: `url` ← `url`, `title` ← `title`, `snippet` ← `content` (the page excerpt), `publishedAt` ← `published_date`; an entry without a usable URL is dropped because the seam guarantees a URL on every source. A request's `maxResults` wins over the configured `maxResults` default and is sent as Tavily's `max_results` for a cost/latency optimization; the final bound is enforced by the seam (truncating `sources[]` and setting `truncated`). Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; a missing key surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

### Auxiliary Tavily request

#### What the model sees

A separate Tavily pipeline receives `<query>` verbatim at its search endpoint. This request is not part of the conversation model's context.

#### Token effect

Tavily-side tokens are incurred per search; the `max_results` sent bounds the retrieved result count.

#### KV Cache effect

Independent of the conversation request cache. An identical query under the same route may reuse provider cache; a changed query or route establishes a different prefix.

### Conversation tool result, indirectly

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the conversation model sees the generated answer plus structured result metadata (URL, title, excerpt, publication date). This provider's exact failures are `Tavily search aborted`, `Tavily search request failed: <error>`, `Tavily search credential resolution failed: <error>`, `Tavily search has no API key for "<ref>"` (with a storage hint), and `Tavily returned an unprocessable response body: <error>`; HTTP failures preserve the provider message. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Answer and source tokens are data-dependent, source count is service-bounded, and the retained result or error is resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A result without a usable URL is dropped entirely** — no portable citation exists for such an entry, so fewer sources than requested can return.
- **The relevance score is discarded** — `score` is provider-internal ranking with no seam field to carry it.
- **Only `searchDepth`/`maxResults`/`includeAnswer` are exposed** — Tavily's other controls (`topic`, `days`, domain filters, raw content, images) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
