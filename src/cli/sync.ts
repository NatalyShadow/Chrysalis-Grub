import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RestDiscord } from "../adapters/rest-adapter.js";
import { loadFragmentsFromDisk } from "../config/fragments.js";
import { loadConfig } from "../config/load.js";
import { runCapture } from "../engine/capture.js";
import { type Binding, ManifestStore } from "../identity/manifest.js";
import type { DiscordPort } from "../port/discord-port.js";
import type { ApiChannel, ApiGuild, ApiOnboarding, ApiRole } from "../port/discord-types.js";
import { error, info, warn } from "../util/logger.js";
import { ExitCode } from "./exit-codes.js";
import { FlagError, type ParsedFlags, parseFlags } from "./flags.js";
import { runMain } from "./run.js";

/**
 * `chrysalis sync --source <guildId> [--output config/clone]`
 *            [--exclude-role <name>] [--exclude-channel <name>]
 *
 * Read-only dump of the source guild into ID-free config fragments:
 * `guild.json`, `roles.json`, `channels.json` and, when the guild has
 * onboarding configured, `onboarding.json` + `prompt-<key>.json` per prompt.
 * The config dir is shared with the onboarding fragments (single config dir,
 * `config/clone`). Logical keys are borrowed from the source manifest where
 * possible so the onboarding refs keep working.
 *
 * Traceability: writes `.chrysalis/clone-source.json` (source guild id +
 * every key → snowflake binding) and MERGES those bindings into the source
 * manifest (`.chrysalis/manifest.json`), so every captured resource stays
 * resolvable.
 *
 * Exit codes: 0 captured · 1 error.
 */

export interface SyncCliOptions {
  port: DiscordPort;
  guildId: string;
  sourceManifestStore: ManifestStore;
  outputDir: string;
  stateDir: string;
  excludeRoles: string[];
  excludeChannels: string[];
}

export async function runSyncCli(options: SyncCliOptions): Promise<number> {
  const { port, guildId, sourceManifestStore, outputDir, stateDir } = options;

  const sourceManifest = await sourceManifestStore.load();

  let guild: ApiGuild;
  let roles: ApiRole[];
  let channels: ApiChannel[];
  let onboarding: ApiOnboarding | undefined;
  try {
    [guild, roles, channels, onboarding] = await Promise.all([
      port.getGuild(guildId),
      port.listRoles(guildId),
      port.listChannels(guildId),
      port.getOnboarding(guildId),
    ]);
  } catch (err) {
    error(`sync failed: ${(err as Error).message}`);
    return ExitCode.Error;
  }

  const result = runCapture({
    guildId,
    guild,
    roles,
    channels,
    onboarding,
    sourceManifest,
    excludeRoleNames: new Set(options.excludeRoles),
    excludeChannelNames: new Set(options.excludeChannels),
  });

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "guild.json"),
      `${JSON.stringify({ guild: result.guild }, null, 2)}\n`,
    );
    await writeFile(
      join(outputDir, "roles.json"),
      `${JSON.stringify({ roles: result.roles }, null, 2)}\n`,
    );
    await writeFile(
      join(outputDir, "channels.json"),
      `${JSON.stringify({ channels: result.channels }, null, 2)}\n`,
    );
    if (result.onboarding) {
      await writeFile(
        join(outputDir, "onboarding.json"),
        `${JSON.stringify({ onboarding: result.onboarding.base }, null, 2)}\n`,
      );
      for (const prompt of result.onboarding.prompts) {
        await writeFile(
          join(outputDir, `prompt-${prompt.key}.json`),
          `${JSON.stringify({ onboarding: { prompts: [prompt] } }, null, 2)}\n`,
        );
      }
    }
    await writeFile(
      resolve(stateDir, "clone-source.json"),
      `${JSON.stringify({ sourceGuildId: guildId, bindings: result.sourceBindings }, null, 2)}\n`,
    );
    // Merge every captured key → snowflake into the source manifest so every
    // captured role/channel stays resolvable (previously only the onboarding
    // role bindings were present, leaving channels unbound).
    await mergeSourceBindings(result.sourceBindings, guildId, sourceManifestStore);
  } catch (err) {
    error(`writing fragments failed: ${(err as Error).message}`);
    return ExitCode.Error;
  }

  // Round-trip validation: the emitted fragments must load and validate.
  try {
    const raw = await loadFragmentsFromDisk(outputDir);
    const semantic = loadConfig(raw).semantic;
    if (semantic.errors.length > 0) {
      for (const e of semantic.errors) {
        warn(`round-trip warning: [${e.path}] ${e.message}`);
      }
    }
  } catch (err) {
    warn(`round-trip validation failed (config/clone may need fixes): ${(err as Error).message}`);
  }

  info(`synced ${guild.name} (${guildId})`);
  info(`  roles: ${result.roles.roles.length} captured, ${result.skippedRoles.length} skipped`);
  info(
    `  channels: ${result.channels.categories?.length ?? 0} categories, ` +
      `${result.channels.channels?.length ?? 0} children, ${result.skippedChannels.length} skipped`,
  );
  info(
    `  overwrites: kept ${result.everyoneOverwrites} @everyone, ` +
      `dropped ${result.droppedMemberOverwrites} member, ${result.droppedRoleOverwrites} role`,
  );
  info(
    `  onboarding: ${result.onboarding?.prompts.length ?? 0} prompt(s) captured, ` +
      `${result.onboarding?.base.defaultChannels?.length ?? 0} default channel(s)`,
  );
  for (const skipped of result.skippedRoles) {
    info(`  skipped role: ${skipped}`);
  }
  for (const skipped of result.skippedChannels) {
    info(`  skipped channel: ${skipped}`);
  }
  info(`fragments written to ${outputDir}`);
  info(
    `source manifest updated: ${Object.keys(result.sourceBindings).length} binding(s) merged into manifest.json`,
  );
  return ExitCode.Converged;
}

export async function main(argv: string[]): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (err instanceof FlagError && err.message === "usage") {
      printUsage();
      return ExitCode.Error;
    }
    throw err;
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    error("DISCORD_TOKEN is not set (use .env or the environment).");
    return ExitCode.Error;
  }
  const guildId = flags.source ?? process.env.GUILD_ID;
  if (!guildId) {
    error("GUILD_ID is not set (use --source <id> or the environment).");
    return ExitCode.Error;
  }

  const outputDir = resolve(flags.output ?? process.env.CHRYSALIS_CLONE_DIR ?? "config/clone");
  const stateDir = resolve(process.env.CHRYSALIS_STATE_DIR ?? ".chrysalis");

  // The source manifest borrows logical keys so the curated onboarding refs
  // (shared config dir, `config/clone`) keep pointing at the captured resources.
  const sourceManifestStore = new ManifestStore(resolve(stateDir, "manifest.json"));

  return runSyncCli({
    port: new RestDiscord(token),
    guildId,
    sourceManifestStore,
    outputDir,
    stateDir,
    excludeRoles: flags.excludeRoles,
    excludeChannels: flags.excludeChannels,
  });
}

function printUsage(): void {
  info(
    "usage: chrysalis sync --source <guildId> [--output config/clone]\n" +
      "       [--exclude-role <name>] [--exclude-channel <name>]\n" +
      "       e.g.  chrysalis sync --source 123456789 --exclude-channel 'SERVER STATS'",
  );
}

/**
 * Merge every captured key → snowflake into the source manifest so every
 * captured role/channel stays resolvable (the manifest previously only
 * carried onboarding role bindings). Existing bindings are preserved; a
 * snowflake already bound to another key is never re-bound (manifest
 * uniqueness invariant). Writes are locked to stay safe against a concurrent
 * run.
 */
async function mergeSourceBindings(
  sourceBindings: Record<string, string>,
  guildId: string,
  manifestStore: ManifestStore,
): Promise<void> {
  let lock: Awaited<ReturnType<ManifestStore["acquireLock"]>> | undefined;
  try {
    lock = await manifestStore.acquireLock();
    const manifest = (await manifestStore.load()) ?? ManifestStore.empty(guildId);
    let changed = false;
    for (const [logicalKey, discordId] of Object.entries(sourceBindings)) {
      const existing = manifest.bindings[logicalKey];
      if (existing && existing.discordId === discordId) continue;
      const conflict = Object.entries(manifest.bindings).find(
        ([key, binding]) => binding.discordId === discordId && key !== logicalKey,
      );
      if (conflict) continue;
      manifest.bindings[logicalKey] = makeBindingFromSource(logicalKey, discordId);
      changed = true;
    }
    if (changed) {
      await manifestStore.save(manifest);
    }
  } finally {
    await lock?.release();
  }
}

/** Build a Binding from a `roles.<key>` / `channels.<key>` source binding. */
function makeBindingFromSource(logicalKey: string, discordId: string): Binding {
  const dot = logicalKey.indexOf(".");
  const prefix = dot === -1 ? "" : logicalKey.slice(0, dot);
  const key = dot === -1 ? logicalKey : logicalKey.slice(dot + 1);
  const kind = prefix === "roles" ? "role" : "channel";
  return {
    key,
    aliases: [],
    kind,
    discordId,
    createdAt: new Date().toISOString(),
  };
}

runMain(import.meta.url, main);
