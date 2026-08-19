import { DuplicateDiscordIdError, type ManifestData, ManifestStore } from "./manifest.js";

/**
 * Adoption (ADR-001 §7, slice decision): an explicit binding step. `adopt`
 * resolves a live resource — by unique name OR by snowflake id — and writes
 * the logical-key → snowflake binding into the manifest.
 *
 * Strict: name matching never guesses — 0 matches or >1 matches abort loudly.
 * An explicit `discordId` skips name matching entirely and binds that snowflake
 * (validated to exist in the live guild).
 */

export interface AdoptCandidate {
  discordId: string;
  name: string;
}

export interface AdoptLookup {
  /** Find live resources by kind and exact name (case-insensitive). */
  listByName(kind: "role" | "channel", name: string): Promise<AdoptCandidate[]>;
  /** Find a live resource by kind and snowflake id (or null if absent). */
  getById(kind: "role" | "channel", discordId: string): Promise<AdoptCandidate | null>;
}

export class AdoptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptError";
  }
}

export interface AdoptOptions {
  kind: "role" | "channel";
  key: string;
  /** Required when `discordId` is not provided. */
  name?: string;
  /** When provided, bind this snowflake directly (skips name matching). */
  discordId?: string;
  lookup: AdoptLookup;
  manifestStore: ManifestStore;
  guildId?: string;
}

export async function adoptResource(options: AdoptOptions): Promise<ManifestData> {
  const { kind, key, manifestStore, guildId } = options;
  const logicalKey = `${kind === "role" ? "roles" : "channels"}.${key}`;

  const manifest = (await manifestStore.load()) ?? ManifestStore.empty(guildId);
  const existing = manifest.bindings[logicalKey];
  if (existing) {
    throw new AdoptError(
      `logical key "${logicalKey}" is already bound to discordId ${existing.discordId}`,
    );
  }

  const candidate = await resolveCandidate(options);
  if (!candidate) {
    if (options.discordId) {
      throw new AdoptError(`no live ${kind} with id ${options.discordId} found; nothing to bind`);
    }
    throw new AdoptError(`no live ${kind} named "${options.name}" found; nothing to bind`);
  }
  const discordId = candidate.discordId;
  for (const [key_, binding] of Object.entries(manifest.bindings)) {
    if (binding.discordId === discordId) {
      throw new DuplicateDiscordIdError(discordId, key_, logicalKey);
    }
  }

  manifest.bindings[logicalKey] = {
    key,
    aliases: [],
    kind,
    discordId,
    createdAt: new Date().toISOString(),
  };
  await manifestStore.save(manifest);
  return manifest;
}

async function resolveCandidate(options: AdoptOptions): Promise<AdoptCandidate | null> {
  const { kind, lookup } = options;

  // Explicit snowflake id wins: exact match, no name guessing.
  if (options.discordId) {
    return lookup.getById(kind, options.discordId);
  }

  const name = options.name;
  if (!name) {
    throw new AdoptError("adopt requires either a <name> or --id <snowflake>");
  }
  const candidates = await lookup.listByName(kind, name);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new AdoptError(
      `ambiguous ${kind} name "${name}": ${candidates.length} matches ` +
        `(${candidates.map((candidate) => candidate.discordId).join(", ")}); ` +
        `Discord permits duplicate names, use --id <snowflake>`,
    );
  }
  return candidates[0] ?? null;
}
