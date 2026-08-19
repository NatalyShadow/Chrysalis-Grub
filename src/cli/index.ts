import { error } from "../util/logger.js";
import { ExitCode } from "./exit-codes.js";
import { runMain } from "./run.js";

/**
 * Entry point: dispatches subcommands.
 *
 *   chrysalis adopt <kind>.<key> <name> [--guild <id>]
 *   chrysalis validate [config path] [--guild <id>]
 *   chrysalis sync --source <guildId> [--output config/clone]
 *   chrysalis create [--guild <id>] [--config config/clone] [--dry-run] [--yes]
 *   chrysalis recover-pending <kind>.<key> --id <snowflake>
 */

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "adopt":
      return (await import("./adopt.js")).main(rest);
    case "validate":
      return (await import("./validate.js")).main(rest);
    case "sync":
      return (await import("./sync.js")).main(rest);
    case "create":
      return (await import("./create.js")).main(rest);
    case "recover-pending":
      return (await import("./recover-pending.js")).main(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return ExitCode.Error;
    default:
      error(`unknown command: ${command}`);
      printUsage();
      return ExitCode.Error;
  }
}

function printUsage(): void {
  process.stdout.write(
    "chrysalis — declarative Discord server provisioner/reconciler (ADR-001)\n\n" +
      "usage:\n" +
      "  chrysalis adopt <role|roles|channel|channels>.<key> <name> [--guild <id>]\n" +
      "  chrysalis adopt <role|roles|channel|channels>.<key> --id <snowflake> [--guild <id>]\n" +
      "  chrysalis validate [config path] [--guild <id>]\n" +
      "  chrysalis sync --source <guildId> [--output config/clone]\n" +
      "                 [--exclude-role <name>] [--exclude-channel <name>]\n" +
      "  chrysalis create [--guild <id>] [--config config/clone] [--dry-run] [--yes]\n" +
      "  chrysalis recover-pending <role|roles|channel|channels>.<key> --id <snowflake> [--guild <id>]\n",
  );
}

runMain(import.meta.url, main);
