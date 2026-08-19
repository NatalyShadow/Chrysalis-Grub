import { resolve } from "node:path";

import { RestDiscord } from "../adapters/rest-adapter.js";
import { loadFragmentsFromDisk } from "../config/fragments.js";
import { loadConfig } from "../config/load.js";
import type { SemanticResult } from "../config/semantic.js";
import { runPreflight } from "../domain/preflight.js";
import { resolveDesired } from "../engine/discover-resolve.js";
import { ManifestStore } from "../identity/manifest.js";
import { error, info } from "../util/logger.js";
import { ExitCode } from "./exit-codes.js";
import { FlagError, type ParsedFlags, parseFlags } from "./flags.js";
import { runMain } from "./run.js";

/**
 * `chrysalis validate [--guild <id>]`
 *
 * Phases 1–2 + 3 + 6: load, validate, discover and run the live pre-flight
 * checks. Stops before Plan/Execute. Exit 0 on success, 1 on any error.
 */

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

  const guildId = flags.guild ?? process.env.GUILD_ID;
  const token = process.env.DISCORD_TOKEN;

  const configDir = resolve(process.env.CHRYSALIS_CONFIG_DIR ?? "config/clone");

  // Phases 1–2: offline validate. Works without a token/guild.
  let semantic: SemanticResult;
  try {
    const raw = await loadFragmentsFromDisk(configDir);
    semantic = loadConfig(raw).semantic;
  } catch (err) {
    error(`config invalid: ${(err as Error).message}`);
    return ExitCode.Error;
  }

  if (semantic.errors.length > 0) {
    for (const e of semantic.errors) {
      error(`  - [${e.path}] ${e.message}`);
    }
    return ExitCode.Error;
  }

  info(`config OK (${semantic.onboarding.prompts.length} prompts)`);

  // Phases 3 + 6: pre-flight needs live data.
  if (token && guildId) {
    const port = new RestDiscord(token);
    const manifest =
      (await new ManifestStore(
        resolve(process.env.CHRYSALIS_STATE_DIR ?? ".chrysalis", "manifest.json"),
      ).load()) ?? ManifestStore.empty(guildId);
    try {
      const discovery = await Promise.all([
        port.listChannels(guildId),
        port.listRoles(guildId),
        port.getOnboarding(guildId),
      ]).then(([channels, roles, onboarding]) => ({ guildId, channels, roles, onboarding }));

      const { resolved, missing } = resolveDesired(
        semantic.onboarding,
        manifest,
        discovery.onboarding.default_channel_ids,
      );
      if (missing.length > 0) {
        error(`unbound keys: ${missing.join(", ")} (run "chrysalis adopt")`);
        return ExitCode.Error;
      }

      const preflight = runPreflight({
        guildId,
        enabled: semantic.onboarding.enabled,
        mode: semantic.onboarding.mode,
        manageDefaultChannels: semantic.onboarding.manageDefaultChannels !== false,
        defaultChannelIds: resolved.defaultChannelIds,
        channels: discovery.channels,
        roles: discovery.roles,
      });
      if (!preflight.ok) {
        for (const e of preflight.errors) {
          error(`pre-flight: ${e}`);
        }
        return ExitCode.Error;
      }
      for (const warning of preflight.warnings) {
        info(`pre-flight warning: [${warning.path}] ${warning.message}`);
      }
      info("pre-flight OK");
    } catch (err) {
      error(`live checks failed: ${(err as Error).message}`);
      return ExitCode.Error;
    }
  } else {
    info("pre-flight skipped (set DISCORD_TOKEN and --guild to run live checks)");
  }

  return ExitCode.Converged;
}

function printUsage(): void {
  info("usage: chrysalis validate [--guild <id>]");
}

runMain(import.meta.url, main);
