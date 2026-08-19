import type { PlanOperation } from "../domain/plan.js";
import type { PreflightResult } from "../domain/preflight.js";
import type { VerifyResult } from "./verify.js";

/**
 * Report rendering (reconciliation.md §7.1). Plain-text summary for the CLI.
 */

export interface ReportInput {
  plan: PlanOperation;
  preflight: PreflightResult;
  verify?: VerifyResult;
  guildId: string;
  dryRun: boolean;
  warnings: string[];
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`Chrysalis sync — guild ${input.guildId}`);
  lines.push("");

  if (input.warnings.length > 0) {
    for (const warning of input.warnings) {
      lines.push(`⚠ ${warning}`);
    }
    lines.push("");
  }

  lines.push(
    `Pre-flight: default channels=${input.preflight.stats.defaultChannels}, ` +
      `allowing SEND_MESSAGES to @everyone=${input.preflight.stats.defaultChannelsAllowingSendMessages}, ` +
      `visible to @everyone=${input.preflight.stats.defaultChannelsVisibleToEveryone}`,
  );
  lines.push("");

  switch (input.plan.op) {
    case "NOOP":
      lines.push("Plan: NOOP — onboarding already converged.");
      break;
    case "UPDATE":
      lines.push("Plan: UPDATE — onboarding will be replaced.");
      if (input.plan.reason) {
        lines.push(`  reason: ${input.plan.reason}`);
      }
      lines.push(`  requests: 1 (PUT /guilds/${input.guildId}/onboarding)`);
      break;
  }

  if (input.dryRun) {
    lines.push("");
    lines.push("dry-run: nothing was executed.");
  } else if (input.verify) {
    lines.push("");
    lines.push(`Verify: ${describeVerify(input.verify)}`);
  }

  lines.push("");
  if (input.plan.op === "NOOP") {
    lines.push("Exit: 0 (converged)");
  } else {
    lines.push("Exit: 2 (changes applied)");
  }
  return lines.join("\n");
}

function describeVerify(verify: VerifyResult): string {
  switch (verify.className) {
    case "converged":
      return "converged";
    case "residual-drift":
      return `residual drift: ${verify.reason ?? "unknown"}`;
    case "verify-failed":
      return `failed: ${verify.reason ?? "unknown"}`;
  }
}
