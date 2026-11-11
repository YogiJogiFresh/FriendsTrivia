import type { ServerClueConfig } from '../lib/apiClient'

export function freeTextConfigForSave(config: ServerClueConfig): ServerClueConfig {
  return {
    ...config,
    acceptedAnswers: (config.acceptedAnswers ?? []).map((answer) => answer.trim()).filter(Boolean),
  }
}
