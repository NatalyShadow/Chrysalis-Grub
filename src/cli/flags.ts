/**
 * CLI flag parsing. Minimal hand-rolled parser (no dependency).
 */

export interface ParsedFlags {
  guild?: string;
  dryRun: boolean;
  yes: boolean;
  continueOnError: boolean;
  verifyWaitMs?: number;
  command?: string;
  /** Snowflake id for `adopt` (bind by id instead of name). */
  id?: string;
  /** Source guild for `sync`. */
  source?: string;
  /** Output directory for `sync` fragments. */
  output?: string;
  /** Config directory (default CHRYSALIS_CONFIG_DIR ?? config/clone). */
  config?: string;
  /** Names excluded by `sync` (repeatable, case-insensitive). */
  excludeRoles: string[];
  excludeChannels: string[];
  positionals: string[];
}

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

export function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    dryRun: false,
    yes: false,
    continueOnError: false,
    excludeRoles: [],
    excludeChannels: [],
    positionals: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--yes") {
      flags.yes = true;
    } else if (arg === "--continue-on-error") {
      flags.continueOnError = true;
    } else if (arg === "--guild") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--guild requires a value");
      }
      flags.guild = value;
      i += 1;
    } else if (arg.startsWith("--guild=")) {
      flags.guild = arg.slice("--guild=".length);
    } else if (arg === "--source") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--source requires a value");
      }
      flags.source = value;
      i += 1;
    } else if (arg.startsWith("--source=")) {
      flags.source = arg.slice("--source=".length);
    } else if (arg === "--output") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--output requires a value");
      }
      flags.output = value;
      i += 1;
    } else if (arg.startsWith("--output=")) {
      flags.output = arg.slice("--output=".length);
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--config requires a value");
      }
      flags.config = value;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      flags.config = arg.slice("--config=".length);
    } else if (arg === "--exclude-role") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--exclude-role requires a value");
      }
      flags.excludeRoles.push(value);
      i += 1;
    } else if (arg === "--exclude-channel") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--exclude-channel requires a value");
      }
      flags.excludeChannels.push(value);
      i += 1;
    } else if (arg === "--command") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--command requires a value");
      }
      flags.command = value;
      i += 1;
    } else if (arg === "--id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--id requires a value");
      }
      flags.id = value;
      i += 1;
    } else if (arg.startsWith("--id=")) {
      flags.id = arg.slice("--id=".length);
    } else if (arg === "--verify-wait-ms") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FlagError("--verify-wait-ms requires a value");
      }
      flags.verifyWaitMs = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      throw new FlagError("usage");
    } else if (arg.startsWith("-")) {
      throw new FlagError(`unknown flag: ${arg}`);
    } else {
      flags.positionals.push(arg);
    }
  }

  return flags;
}
