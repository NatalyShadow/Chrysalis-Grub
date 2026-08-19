import { describe, expect, it } from "vitest";

import { type ReportInput, renderReport } from "../../src/engine/report.js";

function baseInput(): ReportInput {
  return {
    plan: {
      id: "onboarding:onboarding:NOOP",
      op: "NOOP",
      kind: "onboarding",
      safety: { safe: true },
    },
    preflight: {
      ok: true,
      errors: [],
      warnings: [],
      stats: {
        defaultChannels: 7,
        defaultChannelsAllowingSendMessages: 5,
        defaultChannelsVisibleToEveryone: 7,
      },
    },
    guildId: "123",
    dryRun: true,
    warnings: [],
  };
}

describe("renderReport", () => {
  it("renders a NOOP plan with exit 0", () => {
    const report = renderReport(baseInput());
    expect(report).toContain("NOOP");
    expect(report).toContain("Exit: 0 (converged)");
  });

  it("renders an UPDATE plan with the payload request", () => {
    const input = baseInput();
    input.plan = {
      id: "onboarding:onboarding:UPDATE",
      op: "UPDATE",
      kind: "onboarding",
      payload: { prompts: [], default_channel_ids: ["1"], enabled: true },
      reason: "enabled differs",
      safety: { safe: true },
    };
    const report = renderReport(input);
    expect(report).toContain("UPDATE");
    expect(report).toContain("reason: enabled differs");
    expect(report).toContain("PUT /guilds/123/onboarding");
    expect(report).toContain("Exit: 2 (changes applied)");
  });

  it("marks dry-run as not executed", () => {
    const input = baseInput();
    input.plan = {
      id: "onboarding:onboarding:UPDATE",
      op: "UPDATE",
      kind: "onboarding",
      payload: { prompts: [], default_channel_ids: ["1"], enabled: true },
      safety: { safe: true },
    };
    const report = renderReport(input);
    expect(report).toContain("dry-run: nothing was executed");
  });

  it("reports verify convergence when applied", () => {
    const input = baseInput();
    input.dryRun = false;
    input.verify = { className: "converged" };
    const report = renderReport(input);
    expect(report).toContain("Verify: converged");
  });

  it("reports residual drift with its reason", () => {
    const input = baseInput();
    input.dryRun = false;
    input.verify = { className: "residual-drift", reason: "default_channel_ids differ" };
    const report = renderReport(input);
    expect(report).toContain("residual drift: default_channel_ids differ");
  });

  it("reports pre-flight stats", () => {
    const report = renderReport(baseInput());
    expect(report).toContain("default channels=7");
    expect(report).toContain("allowing SEND_MESSAGES to @everyone=5");
  });
});
