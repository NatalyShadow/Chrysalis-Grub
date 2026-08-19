import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { mergeFragments } from "./merge.js";
import type { GuildConfig } from "./types.js";

/**
 * Known top-level fragment kinds. A fragment file may contain more than one,
 * but every top-level key must be a known kind (typos are hard errors).
 *
 * `onboarding` is splittable (base + one file per prompt); `guild`, `roles`
 * and `channels` are singletons (one fragment each — merge.ts hard-errors on
 * a second declaration).
 */
const KNOWN_KINDS = ["onboarding", "guild", "roles", "channels"] as const;
type KnownKind = (typeof KNOWN_KINDS)[number];

function isKnownKind(value: string): value is KnownKind {
  return (KNOWN_KINDS as readonly string[]).includes(value);
}

/**
 * Load pure-data JSON fragments from the `config/` directory (ADR-002
 * amendment: JSON authoring). Reads every `*.json` file, parses it, and merges
 * the fragments. Deterministic: files are sorted by name.
 */
export async function loadFragmentsFromDisk(configDir: string): Promise<GuildConfig> {
  const files = (await readdir(configDir)).filter((file) => file.endsWith(".json")).sort();

  const fragments = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(join(configDir, file), "utf8");
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error(`config fragment "${file}" is not valid JSON: ${(error as Error).message}`);
      }
      const valueObj = value as Record<string, unknown>;
      for (const key of Object.keys(valueObj)) {
        if (!isKnownKind(key)) {
          throw new Error(
            `config fragment "${file}" has unknown top-level kind "${key}" (known kinds: ${KNOWN_KINDS.join(", ")})`,
          );
        }
      }
      return { file, value: valueObj as Partial<GuildConfig> };
    }),
  );

  return mergeFragments(fragments);
}
