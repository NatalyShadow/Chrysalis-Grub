import { resolve } from "node:path";

import { RestDiscord } from "../adapters/rest-adapter.js";
import { loadFragmentsFromDisk } from "../config/fragments.js";
import { CreateError, type CreateOp, runReconcile } from "../engine/create.js";
import { EngineError } from "../engine/engine.js";
import { Journal } from "../identity/journal.js";
import { ManifestLockError, ManifestStore } from "../identity/manifest.js";
import type { DiscordPort } from "../port/discord-port.js";
import { error, info, warn } from "../util/logger.js";
import { ExitCode } from "./exit-codes.js";
import { FlagError, type ParsedFlags, parseFlags } from "./flags.js";
import { runMain } from "./run.js";

/**
 * `chrysalis create [--guild <id>] [--config config/clone] [--dry-run] [--yes]`
 *
 * Builds the TARGET guild from the ID-free spec in `config/clone` using
 * create-and-bind against `.chrysalis/manifest.clone.json`: creates what's
 * missing, patches drift, never deletes. Also runs the onboarding aggregate
 * once roles/channels exist.
 *
 * The plan is ALWAYS computed in dry-run first (phase 1 never mutates); the
 * confirmation gate sits between plan and apply, so answering "n" means
 * nothing was written to Discord (regression-tested in
 * tests/integration/create-cli.test.ts).
 *
 * Exit codes: 0 converged · 1 error · 2 changes (applied or dry-run).
 */

export interface CreateCliOptions {
  port: DiscordPort;
  manifestStore: ManifestStore;
  guildId: string;
  config: unknown;
  journal: Journal;
  /** --dry-run flag: plan only, never applies. */
  dryRun: boolean;
  /** --yes flag: skip the confirmation prompt. */
  yes: boolean;
  /** Confirmation gate; defaults to the readline prompt. Testable stub. */
  confirm?: () => Promise<boolean>;
}

export async function runCreateCli(options: CreateCliOptions): Promise<number> {
  const { port, manifestStore, guildId, config, journal, dryRun, yes } = options;
  const confirm = options.confirm ?? confirmApply;

  // Phase 1: plan (always dry-run — never mutates).
  const planResult = await runReconcile(config, {
    port,
    manifestStore,
    guildId,
    dryRun: true,
    journal,
  });
  renderReport(
    planResult.plan.ops,
    planResult.plan.warnings,
    planResult.plan.deferredChannelOrdering,
    planResult.plan.deferredRoleOrdering,
  );
  for (const role of planResult.plan.untrackedRoles) {
    warn(`untracked role left untouched: ${role}`);
  }
  for (const channel of planResult.plan.untrackedChannels) {
    warn(`untracked channel left untouched: ${channel}`);
  }
  if (planResult.onboarding) {
    info(
      `onboarding: ${planResult.onboarding.plan.op} ` +
        `(verify: ${planResult.onboarding.verify?.className ?? "n/a"})`,
    );
  } else if (planResult.onboardingNote) {
    warn(`onboarding: ${planResult.onboardingNote}`);
  }

  const hasChanges =
    planResult.plan.ops.length > 0 || (planResult.onboarding?.plan.op ?? "NOOP") !== "NOOP";
  if (dryRun) {
    info(`dry-run: ${planResult.plan.ops.length} operation(s) would apply`);
    return hasChanges ? ExitCode.Changes : ExitCode.Converged;
  }

  if (!yes && hasChanges) {
    const confirmed = await confirm();
    if (!confirmed) {
      info("aborted.");
      return ExitCode.Error;
    }
  }

  // Phase 2: apply — the only mutation in the whole run.
  const result = await runReconcile(config, {
    port,
    manifestStore,
    guildId,
    dryRun: false,
    journal,
  });
  if (result.onboarding) {
    info(
      `onboarding: ${result.onboarding.plan.op} ` +
        `(verify: ${result.onboarding.verify?.className ?? "n/a"})`,
    );
  } else if (result.onboardingNote) {
    warn(`onboarding: ${result.onboardingNote}`);
  }
  const converged =
    result.plan.ops.length === 0 && (!result.onboarding || result.onboarding.plan.op === "NOOP");
  info(`create: ${result.applied} operation(s) applied`);
  return converged ? ExitCode.Converged : ExitCode.Changes;
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
  // The target guild id is declared per run (the clone target varies; GUILD_ID
  // in .env is the SOURCE guild that `sync` exports). No .env fallback here.
  const guildId = flags.guild;
  if (!guildId) {
    error("TARGET guild id is not set (use --guild <id>).");
    return ExitCode.Error;
  }

  const configDir = resolve(flags.config ?? process.env.CHRYSALIS_CONFIG_DIR ?? "config/clone");
  const stateDir = resolve(process.env.CHRYSALIS_STATE_DIR ?? ".chrysalis");
  // The clone manifest maps the TARGET guild's snowflakes (which differ from
  // the source guild's, captured by `chrysalis sync`).
  const manifestStore = new ManifestStore(resolve(stateDir, "manifest.clone.json"));
  const journal = new Journal(resolve(stateDir, "journal.clone.jsonl"));

  let rawConfig: unknown;
  try {
    rawConfig = await loadFragmentsFromDisk(configDir);
  } catch (err) {
    error(`config load failed: ${(err as Error).message}`);
    return ExitCode.Error;
  }

  try {
    return await runCreateCli({
      port: new RestDiscord(token),
      manifestStore,
      guildId,
      config: rawConfig,
      journal,
      dryRun: flags.dryRun,
      yes: flags.yes,
    });
  } catch (caught) {
    if (
      caught instanceof CreateError ||
      caught instanceof EngineError ||
      caught instanceof ManifestLockError
    ) {
      error(`create failed: ${(caught as Error).message}`);
      return ExitCode.Error;
    }
    throw caught;
  }
}

function renderReport(
  ops: CreateOp[],
  warnings: string[],
  deferredChannelOrdering: boolean,
  deferredRoleOrdering: boolean,
): void {
  for (const op of ops) {
    switch (op.op) {
      case "create-role":
        info(`create role "${op.key}"`);
        break;
      case "update-role":
        info(`update role "${op.key}" (${Object.keys(op.patch).join(", ")})`);
        break;
      case "reorder-roles":
        info(`reorder roles (${op.entries.length} entries)`);
        break;
      case "create-channel":
        info(`create channel "${op.key}"`);
        break;
      case "update-channel":
        info(`update channel "${op.key}" (${Object.keys(op.patch).join(", ")})`);
        break;
      case "reorder-channels":
        info(`reorder channels (${op.entries.length} entries)`);
        break;
      case "patch-guild":
        info(`patch guild (${Object.keys(op.patch).join(", ")})`);
        break;
      case "enable-community":
        info("enable COMMUNITY (rules + public-updates channels in one PATCH)");
        break;
    }
  }
  for (const warning of warnings) {
    warn(`warning: ${warning}`);
  }
  if (deferredChannelOrdering) {
    info("reorder channels after creates receive their Discord snowflakes");
  }
  if (deferredRoleOrdering) {
    info("reorder roles after creates receive their Discord snowflakes");
  }
}

async function confirmApply(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("Apply changes? (y/N) ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

function printUsage(): void {
  info(
    "usage: chrysalis create [--guild <id>] [--config config/clone]\n" +
      "       [--dry-run] [--yes]\n" +
      "       e.g.  chrysalis create --guild 123456789 --dry-run\n" +
      "             chrysalis create --guild 123456789 --yes",
  );
}

runMain(import.meta.url, main);
