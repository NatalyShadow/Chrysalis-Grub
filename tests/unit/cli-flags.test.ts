import { describe, expect, it } from "vitest";

import { FlagError, parseFlags } from "../../src/cli/flags.js";

describe("parseFlags", () => {
  it("parses --dry-run, --yes and positionals", () => {
    const flags = parseFlags(["sync", "--dry-run", "--yes"]);
    expect(flags.dryRun).toBe(true);
    expect(flags.yes).toBe(true);
    expect(flags.positionals).toEqual(["sync"]);
  });

  it("parses --guild with a separate value", () => {
    const flags = parseFlags(["--guild", "123"]);
    expect(flags.guild).toBe("123");
  });

  it("parses --guild=value form", () => {
    const flags = parseFlags(["--guild=123"]);
    expect(flags.guild).toBe("123");
  });

  it("parses --continue-on-error and --verify-wait-ms", () => {
    const flags = parseFlags(["--continue-on-error", "--verify-wait-ms", "250"]);
    expect(flags.continueOnError).toBe(true);
    expect(flags.verifyWaitMs).toBe(250);
  });

  it("parses --id with a separate value", () => {
    const flags = parseFlags(["roles.hombre", "--id", "999"]);
    expect(flags.id).toBe("999");
    expect(flags.positionals).toEqual(["roles.hombre"]);
  });

  it("parses --id=value form", () => {
    const flags = parseFlags(["roles.hombre", "--id=999"]);
    expect(flags.id).toBe("999");
  });

  it("rejects --id without a value", () => {
    expect(() => parseFlags(["--id"])).toThrow(FlagError);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseFlags(["--nope"])).toThrow(FlagError);
  });

  it("rejects --guild without a value", () => {
    expect(() => parseFlags(["--guild"])).toThrow(FlagError);
  });

  it("treats -h/--help as the usage sentinel", () => {
    for (const arg of ["-h", "--help"]) {
      expect(() => parseFlags([arg])).toThrow(/usage/);
    }
  });
});
