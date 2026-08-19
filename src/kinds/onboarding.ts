import type { DiscordPort } from "../port/discord-port.js";
import type { OnboardingPutBody } from "../port/discord-types.js";

/**
 * Onboarding kind descriptor — isolated so it can later register into the
 * generic KindRegistry (ADR-003) without redesign. For this slice it exposes
 * the four operations the engine needs.
 */

export const onboardingKind = {
  kind: "onboarding",
  managed: false, // aggregate; never deletable independently
} as const;

export interface OnboardingContext {
  port: DiscordPort;
  guildId: string;
}

export async function fetchOnboarding(context: OnboardingContext) {
  return context.port.getOnboarding(context.guildId);
}

export async function applyOnboarding(
  context: OnboardingContext,
  body: OnboardingPutBody,
): Promise<void> {
  await context.port.updateOnboarding(context.guildId, body, `Chrysalis: onboarding.sync`);
}
