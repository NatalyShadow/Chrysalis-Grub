import type { ValidatedOnboarding } from "../config/schema/onboarding.js";
import type { ApiOnboarding } from "../port/discord-types.js";

/**
 * Canonical documents for the onboarding kind (reconciliation.md §4.4).
 *
 * - Both sides normalize to the same shape before diffing.
 * - ABSENT sentinel for `undefined`/`null`/empty lists, so a missing field
 *   equals an explicitly-empty one.
 * - `default_channel_ids` compares as a SET (order-insensitive).
 * - `prompts`/`options` compare as ORDERED lists (their order is meaningful).
 * - Desired docs carry logical refs; current docs carry snowflakes; the
 *   resolved desired doc (phase 4) uses snowflakes and is what gets diffed.
 */

export const ABSENT = Symbol("absent");

export type Absent = typeof ABSENT;

/** Canonical comparison value: a primitive, null, or the ABSENT sentinel. */
export type CanonicalScalar = string | number | boolean | Absent | null;

export interface CanonicalOnboardingOption {
  title: string;
  description: CanonicalScalar;
  emojiName: CanonicalScalar;
  emojiAnimated: CanonicalScalar;
  /** Sorted sets of snowflakes (resolved) — order-insensitive. */
  roleIds: string[];
  channelIds: string[];
}

export interface CanonicalOnboardingPrompt {
  title: string;
  type: number;
  singleSelect: CanonicalScalar;
  required: CanonicalScalar;
  inOnboarding: CanonicalScalar;
  options: CanonicalOnboardingOption[];
}

export interface CanonicalOnboarding {
  enabled: boolean;
  mode: CanonicalScalar;
  defaultChannelIds: string[];
  prompts: CanonicalOnboardingPrompt[];
}

/** Desired-state input: the validated config with refs already resolved. */
export interface ResolvedOnboarding {
  enabled: boolean;
  mode?: "ONBOARDING_DEFAULT" | "ONBOARDING_ADVANCED" | undefined;
  /** Channel snowflakes for defaultChannels (resolved). */
  defaultChannelIds: string[];
  prompts: Array<{
    key: string;
    title: string;
    type: "MULTIPLE_CHOICE" | "DROPDOWN";
    singleSelect?: boolean | undefined;
    required?: boolean | undefined;
    inOnboarding?: boolean | undefined;
    options: Array<{
      key: string;
      title: string;
      description?: string | undefined;
      emoji?: { name: string; animated?: boolean | undefined } | undefined;
      /** Resolved role snowflakes. */
      roleIds: string[];
      /** Resolved channel snowflakes. */
      channelIds: string[];
    }>;
  }>;
}

const PROMPT_TYPE_VALUE = { MULTIPLE_CHOICE: 0, DROPDOWN: 1 } as const;
const MODE_VALUE = { ONBOARDING_DEFAULT: 0, ONBOARDING_ADVANCED: 1 } as const;

/**
 * Canonicalize the RESOLVED desired state. Snowflakes already substituted;
 * emoji kept as flat name/animated.
 */
export function canonicalizeDesired(desired: ResolvedOnboarding): CanonicalOnboarding {
  return {
    enabled: desired.enabled,
    mode: desired.mode === undefined ? ABSENT : (MODE_VALUE[desired.mode] ?? ABSENT),
    defaultChannelIds: [...desired.defaultChannelIds].sort(),
    prompts: desired.prompts.map((prompt) => ({
      title: prompt.title,
      type: PROMPT_TYPE_VALUE[prompt.type],
      // Discord persists these as false when absent (API always returns
      // booleans); an unset spec field must compare equal to current false
      // to avoid perpetual UPDATE (see inOnboarding fix).
      singleSelect: prompt.singleSelect ?? false,
      required: prompt.required ?? false,
      // in_onboarding is a required boolean on Discord's side (the API always
      // returns it); an unset spec field means "not in the flow" → false, so
      // the canonical desired must compare equal to the current `false`.
      inOnboarding: prompt.inOnboarding ?? false,
      options: prompt.options.map((option) => ({
        title: option.title,
        // Discord normalizes a missing description to "" — treat it as none.
        description: option.description ? option.description : ABSENT,
        emojiName: option.emoji?.name ?? ABSENT,
        // The payload always sends emoji_animated (default false); Discord
        // echoes it back, so an unset animated equals false, not ABSENT.
        emojiAnimated: option.emoji ? (option.emoji.animated ?? false) : ABSENT,
        roleIds: [...option.roleIds].sort(),
        channelIds: [...option.channelIds].sort(),
      })),
    })),
  };
}

/**
 * Canonicalize the CURRENT state from the raw API snapshot.
 */
export function canonicalizeCurrent(current: ApiOnboarding): CanonicalOnboarding {
  return {
    enabled: current.enabled,
    mode: current.mode,
    defaultChannelIds: [...current.default_channel_ids].sort(),
    prompts: current.prompts.map((prompt) => ({
      title: prompt.title,
      type: prompt.type,
      singleSelect: prompt.single_select ?? false,
      required: prompt.required ?? false,
      inOnboarding: prompt.in_onboarding ?? false,
      options: prompt.options.map((option) => {
        const hasEmoji = option.emoji != null && option.emoji.name != null;
        return {
          title: option.title,
          // Discord returns "" for a missing description — treat it as none.
          description: option.description ? option.description : ABSENT,
          // Emoji is a unit: without an emoji name, animated is meaningless.
          emojiName: hasEmoji ? (option.emoji?.name ?? ABSENT) : ABSENT,
          // Discord echoes emoji_animated: false for unicode emojis.
          emojiAnimated: hasEmoji ? (option.emoji?.animated ?? false) : ABSENT,
          roleIds: [...option.role_ids].sort(),
          channelIds: [...option.channel_ids].sort(),
        };
      }),
    })),
  };
}

/**
 * Canonical JSON fingerprint — equality of two documents ⇒ NOOP.
 * (Keys sorted; ABSENT serialized as a marker.)
 */
export function fingerprint(doc: CanonicalOnboarding): string {
  return JSON.stringify(serializeAbsent(doc));
}

export function canonicalizeFromValidated(onboarding: ValidatedOnboarding): ResolvedOnboarding {
  return {
    enabled: onboarding.enabled,
    mode: onboarding.mode,
    defaultChannelIds: [], // placeholders — filled by the resolver
    prompts: onboarding.prompts.map((prompt) => ({
      key: prompt.key,
      title: prompt.title,
      type: prompt.type,
      singleSelect: prompt.singleSelect,
      required: prompt.required,
      inOnboarding: prompt.inOnboarding,
      options: prompt.options.map((option) => ({
        key: option.key,
        title: option.title,
        description: option.description,
        emoji: option.emoji,
        roleIds: [],
        channelIds: [],
      })),
    })),
  };
}

function serializeAbsent(value: unknown): unknown {
  if (value === ABSENT) {
    return "\u0000ABSENT\u0000";
  }
  if (Array.isArray(value)) {
    return value.map(serializeAbsent);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = serializeAbsent((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
