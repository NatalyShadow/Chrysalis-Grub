import { type CanonicalOnboarding, canonicalizeCurrent } from "../domain/canonicalize.js";
import { diffOnboarding } from "../domain/diff.js";
import type { DiscordPort } from "../port/discord-port.js";

/**
 * Verify phase (reconciliation.md §7.3): re-discover the onboarding resource,
 * re-diff against the desired canonical document, classify residual drift.
 */

export type DriftClass = "converged" | "residual-drift" | "verify-failed";

export interface VerifyResult {
  className: DriftClass;
  /** Diff reason when residual drift remains. */
  reason?: string;
}

export async function verify(
  port: DiscordPort,
  guildId: string,
  desired: CanonicalOnboarding,
): Promise<VerifyResult> {
  let current: CanonicalOnboarding;
  try {
    const snapshot = await port.getOnboarding(guildId);
    current = canonicalizeCurrent(snapshot);
  } catch (error) {
    return { className: "verify-failed", reason: (error as Error).message };
  }

  const diff = diffOnboarding(desired, current);
  if (diff.op === "NOOP") {
    return { className: "converged" };
  }
  return { className: "residual-drift", ...(diff.reason ? { reason: diff.reason } : {}) };
}
