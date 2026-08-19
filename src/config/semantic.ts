import type {
  OnboardingOption,
  OnboardingPrompt,
  ValidatedChannels,
  ValidatedGuildConfig,
  ValidatedGuildSettings,
  ValidatedOnboarding,
  ValidatedRoles,
} from "./schema/onboarding.js";
import { type AuthoringRef, EVERYONE_REF, type Ref } from "./types.js";

/**
 * Semantic pass (configuration.md §6 stage 2).
 *
 * - Expands bare keys inside kind-scoped arrays into `ref:kind.key`.
 * - Validates reference grammar/kind-matching.
 * - Applies offline business rules (onboarding ≥7 default channels when enabled,
 *   clone fragment cross-references, ordering permutations).
 * - Collects the set of logical keys that require a manifest binding.
 *
 * Pure: no I/O, no discovery. External resources (roles/channels) are referenced
 * but never declared here — binding happens against the manifest in stage 5.
 */

export interface SemanticError {
  path: string;
  message: string;
}

export interface SemanticResult {
  /** Config with every bare key expanded to a canonical `ref:kind.key`. */
  onboarding: ValidatedOnboarding;
  /** Clone fragment sections (guild/roles/channels) when present. */
  guild?: ValidatedGuildSettings;
  roles?: ValidatedRoles;
  channels?: ValidatedChannels;
  /** Logical keys referenced by the config that require a manifest binding. */
  requiredBindings: LogicalRef[];
  /** Logical keys referenced by the onboarding slice only (prompt options,
   *  separator roles, default channels) — channel-overwrite / community refs
   *  are the create flow's business. */
  onboardingBindings: LogicalRef[];
  errors: SemanticError[];
}

/** A validated logical reference: kind + key + full ref string. */
export interface LogicalRef {
  kind: "roles" | "channels";
  key: string;
  ref: Ref;
}

const DEFAULT_CHANNELS_MIN = 7;

export class SemanticErrorException extends Error {
  public readonly errors: SemanticError[];

  constructor(errors: SemanticError[]) {
    super(
      `semantic validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}):\n` +
        errors.map((error) => `  - [${error.path}] ${error.message}`).join("\n"),
    );
    this.name = "SemanticErrorException";
    this.errors = errors;
  }
}

export function runSemanticPass(validated: ValidatedGuildConfig): SemanticResult {
  const errors: SemanticError[] = [];
  const requiredBindings: LogicalRef[] = [];

  const onboarding = validated.onboarding;
  if (onboarding) {
    validateOnboarding(onboarding, errors, requiredBindings);
  }
  // Snapshot the onboarding slice's refs before guild/channels append theirs.
  const onboardingBindings = [...requiredBindings];

  let guild: ValidatedGuildSettings | undefined;
  let roles: ValidatedRoles | undefined;
  let channels: ValidatedChannels | undefined;

  if (validated.guild) {
    guild = validateGuildSettings(validated.guild, errors, requiredBindings);
  }
  if (validated.roles) {
    roles = validateRoles(validated.roles, errors);
  }
  if (validated.channels) {
    channels = validateChannels(validated.channels, errors, requiredBindings);
  }

  return {
    onboarding: onboarding ?? emptyOnboarding(),
    ...(guild ? { guild } : {}),
    ...(roles ? { roles } : {}),
    ...(channels ? { channels } : {}),
    requiredBindings,
    onboardingBindings,
    errors,
  };
}

function emptyOnboarding(): ValidatedOnboarding {
  return { enabled: false, defaultChannels: [], prompts: [] };
}

function validateOnboarding(
  onboarding: ValidatedOnboarding,
  errors: SemanticError[],
  bindings: LogicalRef[],
): void {
  const managesDefaultChannels = onboarding.manageDefaultChannels !== false;

  if (managesDefaultChannels) {
    if (onboarding.enabled && (onboarding.defaultChannels?.length ?? 0) < DEFAULT_CHANNELS_MIN) {
      errors.push({
        path: "onboarding.defaultChannels",
        message:
          `when enabled, onboarding requires at least ${DEFAULT_CHANNELS_MIN} default channels ` +
          `(found ${onboarding.defaultChannels?.length ?? 0}). At least 5 must allow ` +
          `SEND_MESSAGES to @everyone (checked against live state in pre-flight).`,
      });
    }

    for (const ref of onboarding.defaultChannels ?? []) {
      bindings.push(expandRef("channels", ref, "onboarding.defaultChannels", errors));
    }
  }

  const promptKeys = new Set<string>();
  for (const prompt of onboarding.prompts) {
    if (promptKeys.has(prompt.key)) {
      errors.push({
        path: `onboarding.prompts[${prompt.key}]`,
        message: `duplicate prompt key "${prompt.key}"`,
      });
    }
    promptKeys.add(prompt.key);
    validatePrompt(prompt, bindings, errors);
  }
}

function validatePrompt(
  prompt: OnboardingPrompt,
  bindings: LogicalRef[],
  errors: SemanticError[],
): void {
  const base = `onboarding.prompts[${prompt.key}]`;
  if (prompt.separatorRole !== undefined) {
    bindings.push(expandRef("roles", prompt.separatorRole, `${base}.separatorRole`, errors));
  }
  const optionKeys = new Set<string>();
  for (const option of prompt.options) {
    if (optionKeys.has(option.key)) {
      errors.push({
        path: `onboarding.prompts[${prompt.key}].options[${option.key}]`,
        message: `duplicate option key "${option.key}" within prompt "${prompt.key}"`,
      });
    }
    optionKeys.add(option.key);
    validateOption(prompt, option, bindings, errors);
  }
}

function validateOption(
  prompt: OnboardingPrompt,
  option: OnboardingOption,
  bindings: LogicalRef[],
  errors: SemanticError[],
): void {
  const base = `onboarding.prompts[${prompt.key}].options[${option.key}]`;
  for (const ref of option.roles ?? []) {
    bindings.push(expandRef("roles", ref, `${base}.roles`, errors));
  }
  for (const ref of option.channels ?? []) {
    bindings.push(expandRef("channels", ref, `${base}.channels`, errors));
  }
}

/**
 * Expand an authored ref into a validated LogicalRef. Bare keys are scoped to the
 * array kind; `ref:kind.key` must match the expected kind. Invalid refs are
 * recorded as errors and yield a placeholder (never a partial binding).
 */
function expandRef(
  kind: "roles" | "channels",
  authored: AuthoringRef,
  path: string,
  errors: SemanticError[],
): LogicalRef {
  if (authored.startsWith("ref:")) {
    const body = authored.slice("ref:".length);
    const dot = body.indexOf(".");
    const refKind = dot === -1 ? body : body.slice(0, dot);
    const key = dot === -1 ? "" : body.slice(dot + 1);
    if (refKind !== kind) {
      errors.push({
        path,
        message: `reference "${authored}" has kind "${refKind}" but expected "${kind}"`,
      });
      return { kind, key: "", ref: `ref:${kind}.` as Ref };
    }
    if (key === "") {
      errors.push({ path, message: `reference "${authored}" has an empty key` });
      return { kind, key: "", ref: `ref:${kind}.` as Ref };
    }
    return { kind, key, ref: authored as Ref };
  }

  // Bare key: kind-scoped sugar.
  return { kind, key: authored, ref: `ref:${kind}.${authored}` as Ref };
}

// --- clone fragment validation (guild / roles / channels) ---

function validateGuildSettings(
  guild: ValidatedGuildSettings,
  errors: SemanticError[],
  bindings: LogicalRef[],
): ValidatedGuildSettings {
  if (guild.community) {
    if (guild.community.rulesChannel) {
      bindings.push(
        expandRef("channels", guild.community.rulesChannel, "guild.community.rulesChannel", errors),
      );
    }
    if (guild.community.publicUpdatesChannel) {
      bindings.push(
        expandRef(
          "channels",
          guild.community.publicUpdatesChannel,
          "guild.community.publicUpdatesChannel",
          errors,
        ),
      );
    }
  }
  return guild;
}

function validateRoles(roles: ValidatedRoles, errors: SemanticError[]): ValidatedRoles {
  const keys = roles.roles.map((role) => role.key);
  if (new Set(keys).size !== keys.length) {
    errors.push({ path: "roles.roles", message: `duplicate role keys: ${keys.join(", ")}` });
  }
  if (roles.ordering) {
    const unknown = roles.ordering.filter((key) => !keys.includes(key));
    if (unknown.length > 0) {
      errors.push({
        path: "roles.ordering",
        message: `ordering references unknown role keys: ${unknown.join(", ")}`,
      });
    }
    const missing = keys.filter((key) => !roles.ordering?.includes(key));
    if (missing.length > 0) {
      errors.push({
        path: "roles.ordering",
        message: `ordering must include every role key; missing: ${missing.join(", ")}`,
      });
    }
  }
  return roles;
}

function validateChannels(
  channels: ValidatedChannels,
  errors: SemanticError[],
  bindings: LogicalRef[],
): ValidatedChannels {
  const all = [...(channels.categories ?? []), ...(channels.channels ?? [])];
  const keys = all.map((channel) => channel.key);
  if (new Set(keys).size !== keys.length) {
    errors.push({ path: "channels", message: `duplicate channel keys: ${keys.join(", ")}` });
  }
  const categoryKeys = new Set((channels.categories ?? []).map((channel) => channel.key));
  for (const channel of all) {
    const base = `channels[${channel.key}]`;
    if (channel.parent !== undefined) {
      const parentRef = expandRef("channels", channel.parent, `${base}.parent`, errors);
      if (parentRef.key !== "" && !categoryKeys.has(parentRef.key)) {
        errors.push({
          path: `${base}.parent`,
          message: `parent "${channel.parent}" is not a declared category key`,
        });
      }
      bindings.push(parentRef);
    }
    for (const overwrite of channel.overwrites ?? []) {
      // The @everyone overwrite ref is implicit (resolved to the guild id at
      // create time) — it never requires a role binding.
      if (overwrite.ref === EVERYONE_REF) continue;
      bindings.push(expandRef("roles", overwrite.ref, `${base}.overwrites`, errors));
    }
  }
  return channels;
}
