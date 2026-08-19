import { resolve } from "node:path";

import { RestDiscord } from "../adapters/rest-adapter.js";
import { adoptResource } from "../identity/adopt.js";
import { ManifestStore } from "../identity/manifest.js";
import { error, info, warn } from "../util/logger.js";
import { ExitCode } from "./exit-codes.js";
import { FlagError, type ParsedFlags, parseFlags } from "./flags.js";
import { runMain } from "./run.js";

/**
 * `chrysalis adopt <kind>.<key> <name> [--guild <id>]`
 * `chrysalis adopt <kind>.<key> --id <snowflake> [--guild <id>]`
 *
 * Binds an EXISTING live resource (role/channel) to a logical key — by unique
 * name or by snowflake id (ADR-001 §7). Strict: name matching never guesses
 * (0 or >1 matches abort); an explicit --id binds that exact snowflake.
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
  if (!token) {
    error("DISCORD_TOKEN is not set (use .env or the environment).");
    return ExitCode.Error;
  }
  if (!guildId) {
    error("GUILD_ID is not set (use --guild or the environment).");
    return ExitCode.Error;
  }

  const spec = flags.positionals[0];
  const dot = spec?.indexOf(".");
  if (!spec || dot === undefined || dot <= 0 || dot === spec.length - 1) {
    error('adopt expects <kind>.<key> where kind is "role" or "channel"');
    return ExitCode.Error;
  }
  const kindToken = spec.slice(0, dot);
  const key = spec.slice(dot + 1);
  // Accept both singular (role/channel) and plural (roles/channels) spellings,
  // matching manifest logical keys.
  const kind =
    kindToken === "role" || kindToken === "roles"
      ? ("role" as const)
      : kindToken === "channel" || kindToken === "channels"
        ? ("channel" as const)
        : null;
  if (kind === null) {
    error(`unknown kind "${kindToken}" (expected "role" or "channel")`);
    return ExitCode.Error;
  }

  const name = flags.positionals[1];
  if (!name && !flags.id) {
    error("adopt requires either <name> or --id <snowflake>");
    return ExitCode.Error;
  }

  const manifestDir = process.env.CHRYSALIS_STATE_DIR
    ? resolve(process.env.CHRYSALIS_STATE_DIR)
    : resolve(".chrysalis");
  const store = new ManifestStore(resolve(manifestDir, "manifest.json"));
  const port = new RestDiscord(token);

  const lookup = {
    async listByName(targetKind: "role" | "channel", targetName: string) {
      const all = await listAll(port, guildId, targetKind);
      return all.filter((entry) => entry.name.toLowerCase() === targetName.toLowerCase());
    },
    async getById(targetKind: "role" | "channel", targetId: string) {
      const all = await listAll(port, guildId, targetKind);
      return all.find((entry) => entry.discordId === targetId) ?? null;
    },
  };

  try {
    const manifest = await adoptResource({
      kind,
      key,
      ...(name ? { name } : {}),
      ...(flags.id ? { discordId: flags.id } : {}),
      lookup,
      manifestStore: store,
      guildId,
    });
    const logical = `${kind === "role" ? "roles" : "channels"}.${key}`;
    const binding = manifest.bindings[logical];
    info(`adopted ${logical} → ${binding?.discordId} (${name ?? binding?.discordId})`);
    return ExitCode.Converged;
  } catch (err) {
    error(`adopt failed: ${(err as Error).message}`);
    return ExitCode.Error;
  }
}

async function listAll(
  port: RestDiscord,
  guildId: string,
  kind: "role" | "channel",
): Promise<Array<{ discordId: string; name: string }>> {
  if (kind === "role") {
    const roles = await port.listRoles(guildId);
    return roles.map((role) => ({ discordId: role.id, name: role.name }));
  }
  const channels = await port.listChannels(guildId);
  return channels.map((channel) => ({ discordId: channel.id, name: channel.name }));
}

function printUsage(): void {
  warn(
    "usage: chrysalis adopt <role|roles|channel|channels>.<key> <name> [--guild <id>]\n" +
      "       chrysalis adopt <role|roles|channel|channels>.<key> --id <snowflake> [--guild <id>]\n" +
      "       e.g.  chrysalis adopt roles.hombre --id 123456789012345678",
  );
}

runMain(import.meta.url, main);
