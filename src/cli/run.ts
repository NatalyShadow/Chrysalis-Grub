import { pathToFileURL } from "node:url";

/**
 * Standard entry-point footer for CLI files. When the file is executed
 * directly (node/tsx), parse the remaining argv, run main(), and set the
 * process exit code. Safe under test import (no-op).
 */
export function runMain(moduleUrl: string, main: (argv: string[]) => Promise<number>): void {
  const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  if (entryUrl !== undefined && moduleUrl === entryUrl) {
    main(process.argv.slice(2)).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        process.stderr.write(`[fatal] ${(error as Error).stack ?? String(error)}\n`);
        process.exitCode = 70;
      },
    );
  }
}
