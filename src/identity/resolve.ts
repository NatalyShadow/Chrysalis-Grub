import type { ManifestData } from "./manifest.js";

/**
 * Manifest-strict resolution (slice decision, confirmed): a logical key resolves
 * ONLY through a manifest binding. No auto-adoption by name at resolve time.
 * Unbound keys raise UnboundKeyError listing the adopt command.
 */

export interface ResolvedRef {
  logicalKey: string; // e.g. "roles.male"
  discordId: string;
}

export class UnboundKeyError extends Error {
  public readonly logicalKey: string;

  constructor(logicalKey: string) {
    super(
      `logical key "${logicalKey}" has no manifest binding. ` +
        `Create it explicitly with: chrysalis adopt <kind>.<key> <name>`,
    );
    this.name = "UnboundKeyError";
    this.logicalKey = logicalKey;
  }
}

/**
 * Resolve a single logical key (kind.key) to a snowflake.
 * Throws UnboundKeyError when the manifest has no binding.
 */
export function resolveKey(manifest: ManifestData, logicalKey: string): ResolvedRef {
  const binding = manifest.bindings[logicalKey];
  if (!binding) {
    throw new UnboundKeyError(logicalKey);
  }
  return { logicalKey, discordId: binding.discordId };
}

/**
 * Resolve many logical keys. Pure in the sense that it never performs network
 * I/O; it collects all unbound keys and throws a single aggregate error so the
 * caller can report every missing binding at once.
 */
export function resolveKeys(
  manifest: ManifestData,
  logicalKeys: string[],
): {
  resolved: ResolvedRef[];
  missing: string[];
} {
  const resolved: ResolvedRef[] = [];
  const missing: string[] = [];
  for (const logicalKey of logicalKeys) {
    const binding = manifest.bindings[logicalKey];
    if (binding) {
      resolved.push({ logicalKey, discordId: binding.discordId });
    } else {
      missing.push(logicalKey);
    }
  }
  return { resolved, missing };
}
