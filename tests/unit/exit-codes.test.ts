import { describe, expect, it } from "vitest";
import { ExitCode } from "../../src/cli/exit-codes.js";

describe("exit codes", () => {
  it("defines the documented contract", () => {
    expect(ExitCode.Converged).toBe(0);
    expect(ExitCode.Error).toBe(1);
    expect(ExitCode.Changes).toBe(2);
    expect(ExitCode.UnsafePlan).toBe(3);
    expect(ExitCode.Unexpected).toBe(70);
  });
});
