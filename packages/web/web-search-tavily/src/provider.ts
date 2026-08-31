/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API
 * (`POST /search` with bearer auth). It maps `results[]` page excerpts into the
 * seam's normalized sources, maps the optional generated `answer` to `content`,
 * and sends `request.maxResults` as Tavily's `max_results` for a cost/latency
 * optimization (the seam still enforces the bound on return).
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily search endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default retrieval depth: fast basic search. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'basic'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation (credential seam first, launch environment last). */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth: 'basic' | 'advanced'
  /** Default result count when a request carries no `maxResults`. */
  maxResults?: number
  /** Request the generated `answer` from Tavily (mapped to `content`). */
  includeAnswer: boolean
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no usable URL (a source without a URL would make the seam's citation shape
 * lie — the seam guarantees `url` on every source).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no non-blank URL.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined {
  if (result.url === undefined || result.url === null || result.url.length === 0) return undefined
  const title = result.title
  const content = result.content
  const publishedDate = result.published_date
  return {
    url: result.url,
    ...title !== undefined && title !== null && title.length > 0 ? { title } : {},
    ...content !== undefined && content !== null && content.length > 0 ? { snippet: content } : {},
    ...publishedDate !== undefined && publishedDate !== null && publishedDate.length > 0 ? { publishedAt: publishedDate } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result. The generated
 * `answer` maps to `content`; the web service owns the final `maxResults`
 * truncation, so this provider reports `truncated: false`.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; URL-less entries are dropped ({@link mapTavilyResult}).
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return {
    ...response.answer !== undefined && response.answer !== null && response.answer.trim().length > 0 ? { content: response.answer } : {},
    sources,
    truncated: false,
  }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly options: TavilySearchProviderOptions) {}

  available(): boolean {
    return ((this.options.apiKey?.length ?? 0) > 0 || this.options.resolveApiKey !== undefined)
      && isValidBaseUrl(this.options.baseURL)
      && (this.options.maxResults === undefined || isPositiveInteger(this.options.maxResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; either may be absent.
    const maxResults = request.maxResults ?? this.options.maxResults
    const apiKey = await this.apiKey(signal)
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: this.options.searchDepth,
          include_answer: this.options.includeAnswer,
          ...maxResults !== undefined ? { max_results: maxResults } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = typeof parsed.detail === 'string'
          ? parsed.detail
          : parsed.detail?.error ?? parsed.detail?.message ?? parsed.message ?? parsed.error
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    const literal = this.options.apiKey
    if (literal !== undefined && literal.length > 0) return literal
    let resolved: string | undefined
    try {
      resolved = await abortable(this.options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `Tavily search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = this.options.apiKeyEnv ?? 'TAVILY_API_KEY'
    throw new WebError(
      `Tavily search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-tavily config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Tavily (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Tavily search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
