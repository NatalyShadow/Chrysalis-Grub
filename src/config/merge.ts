import type {
  AuthoringRef,
  ChannelsConfig,
  GuildConfig,
  GuildSettingsConfig,
  OnboardingConfig,
  OnboardingMode,
  OnboardingPromptConfig,
  RolesConfig,
} from "./types.js";

/**
 * Typed fragment merge (ADR-002). Fragments are pure-data objects; this composes
 * them into a single GuildConfig and hard-errors on duplicate logical keys.
 *
 * Onboarding is a *splittable* kind: the base fields (`enabled`, `mode`,
 * `defaultChannels`) may appear in at most ONE fragment, while `prompts` may be
 * distributed across many fragments (one prompt per file). Prompt keys are
 * merged by key, so a duplicate prompt key across fragments is a hard error.
 *
 * The clone kinds (`guild`, `roles`, `channels`) are singletons: at most one
 * fragment may declare each, and a second declaration is a hard error.
 */
/**
 * Onboarding as authored in a fragment: any subset of the base fields and/or
 * prompts. The base fields are singletons; prompts may be distributed across
 * fragments (one prompt per file).
 */
export type OnboardingAuthoring = Partial<OnboardingConfig>;

export interface FragmentSource {
  file: string;
  value: {
    onboarding?: OnboardingAuthoring;
    guild?: GuildSettingsConfig;
    roles?: RolesConfig;
    channels?: ChannelsConfig;
  };
}

export class DuplicateKeyError extends Error {
  public readonly kind: string;
  public readonly key: string;
  public readonly sources: string[];

  constructor(kind: string, key: string, sources: string[]) {
    super(`duplicate logical key "${kind}.${key}" across fragments: ${sources.join(", ")}`);
    this.name = "DuplicateKeyError";
    this.kind = kind;
    this.key = key;
    this.sources = sources;
  }
}

/** Onboarding base fields that are singletons (at most one fragment may set them). */
const ONBOARDING_BASE_FIELDS = [
  "enabled",
  "mode",
  "manageDefaultChannels",
  "defaultChannels",
] as const;

export function mergeFragments(fragments: FragmentSource[]): GuildConfig {
  const merged: GuildConfig = {};
  const seen = new Map<string, string[]>();
  const onboarding: {
    enabled?: boolean;
    mode?: OnboardingMode;
    manageDefaultChannels?: boolean;
    defaultChannels?: AuthoringRef[];
    prompts: OnboardingPromptConfig[];
  } = { prompts: [] };

  for (const { file, value } of fragments) {
    if (!value.onboarding) continue;

    const fragment = value.onboarding;
    for (const field of ONBOARDING_BASE_FIELDS) {
      const value_ = fragment[field];
      if (value_ !== undefined) {
        recordKey(seen, "onboarding", field, file);
        if (field === "enabled") onboarding.enabled = value_ as boolean;
        if (field === "mode") onboarding.mode = value_ as OnboardingMode;
        if (field === "manageDefaultChannels") {
          onboarding.manageDefaultChannels = value_ as boolean;
        }
        if (field === "defaultChannels") onboarding.defaultChannels = value_ as AuthoringRef[];
      }
    }
    for (const prompt of fragment.prompts ?? []) {
      recordKey(seen, "onboarding", `prompts.${prompt.key}`, file);
      onboarding.prompts.push(prompt);
    }
  }

  // Clone kinds are singletons — at most one fragment may declare each.
  for (const { file, value } of fragments) {
    if (value.guild !== undefined) {
      recordKey(seen, "guild", "settings", file);
      merged.guild = value.guild;
    }
    if (value.roles !== undefined) {
      recordKey(seen, "roles", "inventory", file);
      merged.roles = value.roles;
    }
    if (value.channels !== undefined) {
      recordKey(seen, "channels", "inventory", file);
      merged.channels = value.channels;
    }
  }

  assertNoDuplicates(seen);

  if (onboarding.prompts.length > 0 || isBasePresent(onboarding)) {
    merged.onboarding = buildOnboarding(onboarding);
  }
  return merged;
}

function isBasePresent(onboarding: {
  enabled?: boolean;
  mode?: OnboardingMode;
  manageDefaultChannels?: boolean;
  defaultChannels?: AuthoringRef[];
  prompts: OnboardingPromptConfig[];
}): boolean {
  return (
    onboarding.enabled !== undefined ||
    onboarding.mode !== undefined ||
    onboarding.manageDefaultChannels !== undefined ||
    onboarding.defaultChannels !== undefined
  );
}

function buildOnboarding(onboarding: {
  enabled?: boolean;
  mode?: OnboardingMode;
  manageDefaultChannels?: boolean;
  defaultChannels?: AuthoringRef[];
  prompts: OnboardingPromptConfig[];
}): OnboardingConfig {
  return {
    enabled: onboarding.enabled ?? false,
    ...(onboarding.mode !== undefined ? { mode: onboarding.mode } : {}),
    ...(onboarding.manageDefaultChannels !== undefined
      ? { manageDefaultChannels: onboarding.manageDefaultChannels }
      : {}),
    defaultChannels: onboarding.defaultChannels ?? [],
    prompts: onboarding.prompts,
  };
}

function recordKey(seen: Map<string, string[]>, kind: string, key: string, file: string): void {
  const logical = `${kind}.${key}`;
  const list = seen.get(logical) ?? [];
  list.push(file);
  seen.set(logical, list);
}

function assertNoDuplicates(seen: Map<string, string[]>): void {
  for (const [logical, sources] of seen) {
    if (sources.length > 1) {
      const dot = logical.indexOf(".");
      const kind = dot === -1 ? logical : logical.slice(0, dot);
      const key = dot === -1 ? logical : logical.slice(dot + 1);
      throw new DuplicateKeyError(kind, key, sources);
    }
  }
}
