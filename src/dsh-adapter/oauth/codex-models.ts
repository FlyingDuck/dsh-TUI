/**
 * Temporary gap-fill for the Codex catalog bundled with pi-ai 1.5.2.
 * Values are from Pi's official online catalog, checked 2026-11-20:
 * https://pi.dev/models/openai-codex/gpt-6-2-astra
 * https://pi.dev/models/openai-codex/gpt-6-2-sol
 *
 * Keep native entries authoritative. Remove this supplement once the minimum
 * supported host ships both models; do not replace auth or wire implementations.
 */
import type { PiAiProvider } from './pi-ai.js'

type Model = ReturnType<PiAiProvider['getModels']>[number]
type CatalogModel = PiAiProvider extends { getAllModels(): readonly (infer T)[] } ? T : Model

const common = {
  provider: 'openai-codex',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text', 'image'],
  maxTokens: 128000,
  thinkingLevelMap: {
    off: null,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  },
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true,
  },
} satisfies Partial<Model>

const supplements: readonly Model[] = [
  {
    ...common,
    id: 'gpt-6.2-astra',
    name: 'GPT-6.2 Astra',
    contextWindow: 272000,
    cost: {
      input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
      tiers: [{ inputTokensAbove: 272000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
    },
  },
  {
    ...common,
    id: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    contextWindow: 500000,
    cost: {
      input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
  },
]

/** Supplement only our Codex OAuth route, without changing shared catalog data. */
export function withCodexModelSupplement(provider: PiAiProvider): PiAiProvider {
  if (provider.id !== 'openai-codex') return provider
  const models = provider.getModels()
  const ids = new Set(models.map(model => model.id))
  const missing = supplements.filter(model => !ids.has(model.id)).map(model => structuredClone(model))
  if (missing.length === 0) return provider
  // Newer pi-ai also exposes typed catalogs. Keep those reads consistent,
  // while retaining image/classifier entries and compatibility with old hosts.
  const typed = provider as PiAiProvider & { getAllModels?: () => readonly CatalogModel[] }
  const allModels = typeof typed.getAllModels === 'function' ? typed.getAllModels() : undefined
  return {
    ...provider,
    getModels: () => [...models, ...missing],
    ...(allModels === undefined ? {} : { getAllModels: () => [...allModels, ...missing] }),
  }
}
