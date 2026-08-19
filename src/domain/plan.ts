import type { ApiOnboarding, OnboardingPutBody } from "../port/discord-types.js";
import type { CanonicalOnboarding, ResolvedOnboarding } from "./canonicalize.js";

/**
 * Plan for the onboarding kind (reconciliation.md §5).
 *
 * One aggregate resource ⇒ at most one operation. An UPDATE carries the full
 * desired payload (PUT semantics). Prompt/option ids are reused from the
 * CURRENT state where a stable match exists (by title) so re-runs do not churn
 * ids; genuinely new prompts get a generated id (the API requires the field —
 * see discord-api-types v10 RESTAPIGuildOnboardingPrompt).
 */

export type PlanOperationKind = "UPDATE" | "NOOP";

export interface PlanOperation {
  id: string;
  op: PlanOperationKind;
  kind: "onboarding";
  /** Full PUT body; only present when op === "UPDATE". */
  payload?: OnboardingPutBody | undefined;
  reason?: string | undefined;
  safety: { safe: true };
}

export interface PlanInput {
  desired: ResolvedOnboarding;
  desiredCanonical: CanonicalOnboarding;
  current: ApiOnboarding;
  diff: "NOOP" | "UPDATE";
  diffReason?: string;
}

/**
 * Build the deterministic plan. Id reuse strategy:
 * - prompt: reuse current prompt id when its title matches a desired prompt
 *   (positional fallback by index for identical titles).
 * - option: reuse current option id by title within the matched prompt.
 */
export function buildPlan(input: PlanInput): PlanOperation {
  if (input.diff === "NOOP") {
    return {
      id: "onboarding:onboarding:NOOP",
      op: "NOOP",
      kind: "onboarding",
      safety: { safe: true },
    };
  }

  const payload = buildPayload(input.desired, input.current);
  return {
    id: "onboarding:onboarding:UPDATE",
    op: "UPDATE",
    kind: "onboarding",
    payload,
    reason: input.diffReason,
    safety: { safe: true },
  };
}

export function buildPayload(
  desired: ResolvedOnboarding,
  current: ApiOnboarding,
): OnboardingPutBody {
  const usedPromptIndexes = new Set<number>();

  const prompts = desired.prompts.map((prompt) => {
    // Reuse a current prompt id with the same title, preferring first unused.
    let matchedId: string | undefined;
    for (let i = 0; i < current.prompts.length; i += 1) {
      if (usedPromptIndexes.has(i)) continue;
      if (current.prompts[i]?.title === prompt.title) {
        matchedId = current.prompts[i]?.id;
        usedPromptIndexes.add(i);
        break;
      }
    }

    const matchedPrompt = current.prompts.find((p) => p.id === matchedId);
    const usedOptionIndexes = new Set<number>();

    return {
      id: matchedId ?? generateSnowflake(),
      title: prompt.title,
      single_select: prompt.singleSelect,
      required: prompt.required,
      // Never omit: Discord defaults a missing in_onboarding to true, which
      // would flood the onboarding flow with post-join prompts and trip the
      // 5-in-flow limit (TOO_MANY_ONBOARDING_PROMPTS). An unset field in the
      // spec means "not in the flow" (post-join) → false.
      in_onboarding: prompt.inOnboarding ?? false,
      type: prompt.type === "MULTIPLE_CHOICE" ? 0 : 1,
      options: prompt.options.map((option) => {
        let optionId: string | undefined;
        if (matchedPrompt) {
          for (let i = 0; i < matchedPrompt.options.length; i += 1) {
            if (usedOptionIndexes.has(i)) continue;
            if (matchedPrompt.options[i]?.title === option.title) {
              optionId = matchedPrompt.options[i]?.id;
              usedOptionIndexes.add(i);
              break;
            }
          }
        }
        const flatEmoji = option.emoji
          ? {
              emoji_id: null,
              emoji_name: option.emoji.name,
              emoji_animated: option.emoji.animated ?? false,
            }
          : undefined;
        return {
          id: optionId,
          title: option.title,
          description: option.description,
          channel_ids: option.channelIds,
          role_ids: option.roleIds,
          ...flatEmoji,
        };
      }),
    };
  });

  return {
    prompts,
    default_channel_ids: [...desired.defaultChannelIds].sort(),
    enabled: desired.enabled,
    mode: desired.mode === "ONBOARDING_ADVANCED" ? 1 : 0,
  };
}

/**
 * Generate a snowflake-like id for new prompts. The API requires the field but
 * ignores it for newly-created prompts (discord.js generates one too). A
 * timestamp-based snowflake keeps ids plausibly unique and ascending.
 */
export function generateSnowflake(): string {
  const timestamp = BigInt(Date.now()) << 22n;
  const random = BigInt(Math.floor(Math.random() * 0x100000));
  return (timestamp | random).toString();
}
