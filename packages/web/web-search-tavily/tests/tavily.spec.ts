import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WebRuntime from '@deepseek-ai/dsh-web'
import { TavilySearchProvider, TAVILY_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'

const options = {
  apiKey: 'tvly-key',
  baseURL: 'https://api.tavily.test',
  searchDepth: 'basic' as const,
  includeAnswer: true,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      content: 'page excerpt',
      score: 0.91,
      published_date: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'page excerpt', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable URL', () => {
    expect(mapTavilyResult({ title: 'no url' })).toBeUndefined()
    expect(mapTavilyResult({ url: null, title: 'no url' })).toBeUndefined()
    expect(mapTavilyResult({ url: '', title: 'no url' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: null, content: null, published_date: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', title: '', content: '', published_date: '' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a response with a generated answer to content', () => {
    const result = mapTavilyResponse({
      answer: 'generated answer',
      results: [
        { url: 'https://a.test', content: 'one' },
        { title: 'no url' },
        { url: 'https://c.test', title: 'C' },
      ],
    })
    expect(result).toEqual({
      content: 'generated answer',
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C' },
      ],
      truncated: false,
    })
  })

  it('omits content when the answer is absent or blank', () => {
    expect(mapTavilyResponse({ results: [] })).not.toHaveProperty('content')
    expect(mapTavilyResponse({ answer: '  ', results: [] })).not.toHaveProperty('content')
    expect(mapTavilyResponse({ answer: null, results: [] })).not.toHaveProperty('content')
  })

  it('tolerates a missing results array', () => {
    expect(mapTavilyResponse({}).sources).toEqual([])
  })
})

describe('TavilySearchProvider availability', () => {
  it('is unavailable without a key and without a resolver', () => {
    const { apiKey: _apiKey, ...rest } = options
    expect(new TavilySearchProvider({ ...rest, baseURL: 'https://api.tavily.test' }).available()).toBe(false)
  })

  it('is available with a literal key', () => {
    expect(new TavilySearchProvider(options).available()).toBe(true)
  })

  it('is available with a resolver standing in for the credential plane', () => {
    const { apiKey: _apiKey, ...rest } = options
    expect(new TavilySearchProvider({ ...rest, resolveApiKey: async () => undefined }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new TavilySearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxResults is set but not a positive integer', () => {
    expect(new TavilySearchProvider({ ...options, maxResults: -1 }).available()).toBe(false)
    expect(new TavilySearchProvider({ ...options, maxResults: 1.5 }).available()).toBe(false)
  })
})

describe('TavilySearchProvider request mapping', () => {
  it('sends query, search_depth, include_answer, max_results and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new TavilySearchProvider({ ...options, searchDepth: 'advanced', includeAnswer: false })
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tvly-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      search_depth: 'advanced',
      include_answer: false,
      max_results: 5,
    })
  })

  it('falls back to the configured maxResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new TavilySearchProvider({ ...options, maxResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 7 })
  })

  it('lets a request maxResults win over the configured maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new TavilySearchProvider({ ...options, maxResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 2 })
  })

  it('omits max_results when neither maxResults nor a configured default is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new TavilySearchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('max_results')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new TavilySearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('TavilySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'invalid api key' }, { status: 401 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'invalid api key' }))
  })

  it('unwraps a FastAPI-style object detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: { error: 'quota exceeded' } }, { status: 429 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'quota exceeded' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('throws WEB_PROVIDER_CREDENTIAL_MISSING with a diagnostic when no key resolves', async () => {
    const { apiKey: _apiKey, ...rest } = options
    const provider = new TavilySearchProvider({
      ...rest,
      resolveApiKey: async () => undefined,
      apiKeyEnv: credentialRef('TAVILY_API_KEY'),
    })
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('threads searchDepth, includeAnswer and maxResults config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key', searchDepth: 'advanced', includeAnswer: false, maxResults: 9 })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ search_depth: 'advanced', include_answer: false, max_results: 9 })
    await fiber.dispose()
  })

  it('falls back to $TAVILY_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      const fiber = await ctx.plugin(tavilyPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://api.tavily.com/search')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('reports a credential diagnostic when neither config nor environment supplies a key', async () => {
    const prev = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev !== undefined) process.env.TAVILY_API_KEY = prev
    }
  })
})
