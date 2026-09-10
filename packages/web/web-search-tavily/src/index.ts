/**
 * `@deepseek-ai/dsh-web-search-tavily`: registers a Tavily-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-exa` does.
 * The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { TavilySearchProviderOptions } from './provider.ts'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
} from './provider.ts'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
} from './provider.ts'
export type { TavilySearchProviderOptions }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default credential reference naming this provider's key. */
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tavily API key; prefer the credential reference so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval depth sent as Tavily's `search_depth`. Defaults to `basic`. */
  searchDepth?: 'basic' | 'advanced'
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  maxResults?: number
  /** Request the generated `answer` from Tavily (mapped to `content`). Defaults to `true`. */
  includeAnswer?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchDepth: z.union(['basic', 'advanced'] as const),
  maxResults: z.number().step(1).min(1),
  includeAnswer: z.boolean(),
})

/**
 * Project one config into the options the provider serves its next
 * searches with. Environment fallbacks stay here rather than in the
 * provider: the credential seam (when mounted) wins over the launch
 * environment, and every value the provider reads is already defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the authoritative config for the row.
 * @returns options for the provider.
 */
function resolveOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  return {
    ...config.apiKey !== undefined && config.apiKey.length > 0 ? { apiKey: config.apiKey } : {},
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
    ...config.maxResults !== undefined ? { maxResults: config.maxResults } : {},
    includeAnswer: config.includeAnswer ?? true,
  }
}

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new TavilySearchProvider(resolveOptions(ctx, config)))
}
