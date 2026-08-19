/**
 * Core config types (ADR-002). Author-facing identity is the logical key;
 * references are `ref:kind.key` (bare-key sugar expands in the semantic pass).
 */

export type Kind = "roles" | "channels" | "onboarding";

export type LogicalKey<K extends Kind = Kind> = `${K}.${string}`;

export type Ref<K extends Kind = Kind> = `ref:${LogicalKey<K>}`;

/**
 * A reference as authored. Within kind-scoped arrays (`roles: [...]`, `channels: [...]`)
 * bare keys are accepted and expanded to `ref:kind.key` by the semantic pass.
 */
export type AuthoringRef = Ref | string;

/**
 * Special overwrite ref for the implicit @everyone role (id === guildId).
 * Used by the clone flow: captured as a bare key, resolved to the target
 * guild's id at create time. Never requires a role binding.
 */
export const EVERYONE_REF = "@everyone";

/** Onboarding mode (maps to GuildOnboardingMode 0/1 at the adapter). */
export type OnboardingMode = "ONBOARDING_DEFAULT" | "ONBOARDING_ADVANCED";

/** Prompt type (maps to GuildOnboardingPromptType 0/1 at the adapter). */
export type OnboardingPromptType = "MULTIPLE_CHOICE" | "DROPDOWN";

export interface OnboardingEmoji {
  name: string;
  animated?: boolean;
}

export interface OnboardingOptionConfig {
  /** Sub-sub-resource identity, e.g. "chat" → ref:onboarding.prompts.<p>.options.chat */
  key: string;
  title: string;
  description?: string;
  /** Authoring sugar: a bare emoji string or `{ name, animated? }`. */
  emoji?: OnboardingEmoji | string;
  /** Role logical keys (bare or ref) granted when selected. */
  roles?: AuthoringRef[];
  /** Channel logical keys (bare or ref) granted when selected. */
  channels?: AuthoringRef[];
  /**
   * Inline role binding: the snowflake of the option's single role.
   * Accepted for backward compatibility with configs authored with inline
   * snowflakes (an empty string marks an unfilled placeholder).
   */
  roleId?: string;
}

export interface OnboardingPromptConfig {
  /** Sub-resource identity, e.g. "choose-your-path". */
  key: string;
  title: string;
  type: OnboardingPromptType;
  singleSelect?: boolean;
  required?: boolean;
  inOnboarding?: boolean;
  /**
   * Separator role: granted to every member who answers ANY option of this
   * prompt (e.g. `genero` for gender, `pais` for country). Unlike `roles` on
   * an option, it is declared once per prompt and added to every option's
   * role_ids by the resolver.
   */
  separatorRole?: AuthoringRef;
  /** Inline binding for the separator role (snowflake or "" placeholder). */
  separatorRoleId?: string;
  options: OnboardingOptionConfig[];
}

export interface OnboardingConfig {
  enabled: boolean;
  mode?: OnboardingMode;
  /**
   * Whether this tool manages the server's default channels. When false, the
   * server's current default channels are carried through and never diffed —
   * only the prompts are applied. When omitted/true, `defaultChannels` is
   * required and fully reconciled.
   */
  manageDefaultChannels?: boolean;
  /** Channel logical keys (bare or ref) that members are auto-opted into. */
  defaultChannels?: AuthoringRef[];
  prompts: OnboardingPromptConfig[];
}

export interface GuildConfig {
  onboarding?: OnboardingConfig;
  /** Server-wide settings (clone flow). Singleton fragment. */
  guild?: GuildSettingsConfig;
  /** Full role inventory (clone flow). Singleton fragment. */
  roles?: RolesConfig;
  /** Full channel inventory, categories + children (clone flow). Singleton fragment. */
  channels?: ChannelsConfig;
}

/** Guild-level settings managed by `create` (docs/clone-server.md). */
export interface GuildSettingsConfig {
  name?: string;
  /** 0–4 (explicit_content_filter / verification_level enums). */
  verificationLevel?: number;
  explicitContentFilter?: number;
  /** 0 = all messages, 1 = only @mentions. */
  defaultMessageNotifications?: number;
  preferredLocale?: string;
  /** Enables the COMMUNITY feature. Both channels are required when set. */
  community?: {
    /** Logical channel key for rules_channel_id (ref or bare key). */
    rulesChannel?: AuthoringRef;
    /** Logical channel key for public_updates_channel_id (ref or bare key). */
    publicUpdatesChannel?: AuthoringRef;
  };
}

/** A single role declaration. Identity = the logical key. */
export interface RoleConfig {
  key: string;
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  /** Base-10 permission bitfield string. */
  permissions?: string;
  icon?: string;
  unicodeEmoji?: string;
}

export interface RolesConfig {
  roles: RoleConfig[];
  /** Position order, top-first (highest first). Optional — defaults to declaration order. */
  ordering?: string[];
}

/** A permission overwrite declared against a role logical key. */
export interface ChannelOverwriteConfig {
  ref: AuthoringRef;
  /** Base-10 allow bitfield string. */
  allow?: string;
  /** Base-10 deny bitfield string. */
  deny?: string;
}

/** A single channel declaration (category or child). */
export interface ChannelConfig {
  key: string;
  name: string;
  /** ChannelType enum value (0 text, 2 voice, 4 category, 13 forum, ...). */
  type: number;
  /** Logical channel key of the parent category (categories have none). */
  parent?: AuthoringRef;
  topic?: string;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  bitrate?: number;
  userLimit?: number;
  videoQualityMode?: number;
  defaultAutoArchiveDuration?: number;
  availableTags?: Array<{
    name: string;
    emojiName?: string;
  }>;
  overwrites?: ChannelOverwriteConfig[];
}

export interface ChannelsConfig {
  categories?: ChannelConfig[];
  channels?: ChannelConfig[];
  /** Position order (categories then children, grouped by parent). Optional. */
  ordering?: string[];
}
