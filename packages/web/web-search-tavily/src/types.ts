/**
 * Wire types for the Tavily search API (`POST https://api.tavily.com/search`). Types
 * only — no runtime code. Tavily returns a `results[]` array of page excerpts
 * (URL, title, content, relevance `score`, optional `published_date`) plus an
 * optional generated `answer` when the request asks for one.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  /** Retrieval depth: `basic` (fast) or `advanced` (deeper crawl). */
  search_depth: 'basic' | 'advanced'
  /** Tavily's result-count control; the seam still enforces the bound on return. */
  max_results?: number
  /** Ask Tavily to generate a short answer from the retrieved pages. */
  include_answer: boolean
}

/** One entry of Tavily's `results[]`. */
export interface TavilyResult {
  url?: string | null
  title?: string | null
  /** The page excerpt Tavily retrieved for this result. */
  content?: string | null
  /** Tavily's relevance score; provider-private and not mapped. */
  score?: number
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  query?: string
  /** Generated answer, present when `include_answer` was requested. */
  answer?: string | null
  results?: TavilyResult[]
  response_time?: number
}

/**
 * Tavily's error response envelope (best-effort; FastAPI-style `detail` may be a
 * string or an object carrying the message). Fields vary by failure.
 */
export interface TavilyError {
  detail?: string | { error?: string; message?: string } | null
  message?: string
  error?: string
}
