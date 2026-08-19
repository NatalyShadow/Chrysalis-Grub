import { parseGuildConfig, type ValidatedGuildConfig } from "./schema/onboarding.js";
import { runSemanticPass, type SemanticResult } from "./semantic.js";

export interface LoadedConfig {
  guildConfig: ValidatedGuildConfig;
  semantic: SemanticResult;
}

/**
 * Load + validate a raw config object. Pure (no I/O): callers read fragments
 * from disk or tests pass objects directly.
 *
 * Pipeline stages 0–2 (configuration.md §6):
 *   0 merge fragments (caller), 1 Zod schema, 2 semantic pass.
 */
export function loadConfig(raw: unknown): LoadedConfig {
  const validated = parseGuildConfig(raw);
  const semantic = runSemanticPass(validated);
  return { guildConfig: validated, semantic };
}
