import { resolve } from "node:path";

import { RestDiscord } from "../adapters/rest-adapter.js";
import {
  completePendingCreate,
  ManifestPendingCreateError,
  ManifestStore,
} from "../identity/manifest.js";
import { error, info } from "../util/logger.js";
import { ExitCode } from "./exit-codes.js";
import { FlagError, type ParsedFlags, parseFlags } from "./flags.js";
import { runMain } from "./run.js";

/**
 * Resolve a pending create after an operator has inspected the target guild:
 *
 *   chrysalis recover-pending roles.admin --id <snowflake> [--guild <id>]
 *
 * This command only updates manifest.clone.json. It never creates or patches a
 * Discord resource; the explicit snowflake is the operator's confirmation of
 * which remote resource survived the ambiguous POST.
 */
export async function main(argv: string[]): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(argv);
  } catch (caught) {
    if (caught instanceof FlagError && caught.message === "usage") {
      printUsage();
      return ExitCode.Error;
    }
    throw caught;
  }

  const target = parseTarget(flags.positionals[0]);
  if (!target) {
    error("recover-pending expects <role|roles|channel|channels>.<key>");
    return ExitCode.Error;
  }
  if (!flags.id) {
    error("recover-pending requires --id <snowflake>");
    return ExitCode.Error;
  }

  // The target guild id is declared per run (GUILD_ID in .env is the SOURCE
  // guild). No .env fallback here.
  const guildId = flags.guild;
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    error("DISCORD_TOKEN is not set (use .env or the environment).");
    return ExitCode.Error;
  }
  if (!guildId) {
    error("TARGET guild id is not set (use --guild <id>).");
    return ExitCode.Error;
  }

  const stateDir = resolve(process.env.CHRYSALIS_STATE_DIR ?? ".chrysalis");
  const store = new ManifestStore(resolve(stateDir, "manifest.clone.json"));

  let lock: Awaited<ReturnType<ManifestStore["acquireLock"]>> | undefined;
  try {
    lock = await store.acquireLock();
    const manifest = await store.load();
    if (!manifest) {
      throw new ManifestPendingCreateError(
        target.logicalKey,
        "target manifest.clone.json does not exist",
      );
    }
    if (manifest.meta.guildId && manifest.meta.guildId !== guildId) {
      throw new ManifestPendingCreateError(
        target.logicalKey,
        `target manifest belongs to guild ${manifest.meta.guildId}, not ${guildId}`,
      );
    }

    const port = new RestDiscord(token);
    if (target.kind === "role") {
      const role = (await port.listRoles(guildId)).find((candidate) => candidate.id === flags.id);
      if (!role) {
        throw new ManifestPendingCreateError(
          target.logicalKey,
          `no live role with id ${flags.id} was found in guild ${guildId}`,
        );
      }
      if (role.managed === true) {
        throw new ManifestPendingCreateError(
          target.logicalKey,
          `managed role ${flags.id} cannot resolve a Chrysalis create`,
        );
      }
      completePendingCreate(manifest, target.kind, target.key, flags.id);
      await store.save(manifest);
      info(`recovered ${target.logicalKey} → ${flags.id} (${role.name})`);
      return ExitCode.Changes;
    }

    const channel = (await port.listChannels(guildId)).find(
      (candidate) => candidate.id === flags.id,
    );
    if (!channel) {
      throw new ManifestPendingCreateError(
        target.logicalKey,
        `no live channel with id ${flags.id} was found in guild ${guildId}`,
      );
    }
    completePendingCreate(manifest, target.kind, target.key, flags.id);
    await store.save(manifest);
    info(`recovered ${target.logicalKey} → ${flags.id} (${channel.name})`);
    return ExitCode.Changes;
  } catch (caught) {
    error(`pending recovery failed: ${(caught as Error).message}`);
    return ExitCode.Error;
  } finally {
    await lock?.release();
  }
}

interface RecoveryTarget {
  kind: "role" | "channel";
  key: string;
  logicalKey: string;
}

function parseTarget(spec: string | undefined): RecoveryTarget | undefined {
  if (!spec) return undefined;
  const dot = spec.indexOf(".");
  if (dot <= 0 || dot === spec.length - 1) return undefined;
  const kindToken = spec.slice(0, dot);
  const key = spec.slice(dot + 1);
  const kind =
    kindToken === "role" || kindToken === "roles"
      ? "role"
      : kindToken === "channel" || kindToken === "channels"
        ? "channel"
        : undefined;
  if (!kind) return undefined;
  return {
    kind,
    key,
    logicalKey: `${kind === "role" ? "roles" : "channels"}.${key}`,
  };
}

function printUsage(): void {
  info(
    "usage: chrysalis recover-pending <role|roles|channel|channels>.<key> --id <snowflake> [--guild <id>]",
  );
}

runMain(import.meta.url, main);
