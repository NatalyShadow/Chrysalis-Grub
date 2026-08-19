/**
 * App-side API shapes — the ONLY types crossing the port boundary.
 * Never discord.js types. snake_case, matching raw REST JSON (reconciliation.md §4.4).
 */

export interface ApiPermissionOverwrite {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string; // base-10 string
  deny: string; // base-10 string
}

export interface ApiChannel {
  id: string;
  name: string;
  /** ChannelType enum value (raw REST JSON). */
  type: number;
  permission_overwrites?: ApiPermissionOverwrite[] | undefined;
  parent_id?: string | null | undefined;
  position?: number | undefined;
  topic?: string | null | undefined;
  nsfw?: boolean | undefined;
  rate_limit_per_user?: number | undefined;
  bitrate?: number | undefined;
  user_limit?: number | undefined;
  video_quality_mode?: number | undefined;
  default_auto_archive_duration?: number | undefined;
  available_tags?:
    | Array<{
        id: string;
        name: string;
        emoji_id?: string | null | undefined;
        emoji_name?: string | null | undefined;
        moderated?: boolean | undefined;
      }>
    | undefined;
}

export interface ApiRole {
  id: string;
  name: string;
  permissions: string; // base-10 string
  color?: number | undefined;
  hoist?: boolean | undefined;
  mentionable?: boolean | undefined;
  position?: number | undefined;
  icon?: string | null | undefined;
  unicode_emoji?: string | null | undefined;
  managed?: boolean | undefined;
}

export interface ApiGuild {
  id: string;
  name: string;
  features: string[];
  verification_level?: number | undefined;
  explicit_content_filter?: number | undefined;
  default_message_notifications?: number | undefined;
  preferred_locale?: string | undefined;
  rules_channel_id?: string | null | undefined;
  public_updates_channel_id?: string | null | undefined;
}

export interface ApiOnboardingPromptOption {
  id: string;
  channel_ids: string[];
  role_ids: string[];
  /**
   * Discord returns the option emoji as a NESTED object in responses
   * (`emoji: { id, name, animated }`), even though the PUT body accepts the
   * flat legacy fields (`emoji_id`/`emoji_name`/`emoji_animated`).
   */
  emoji?: { id: string | null; name: string | null; animated?: boolean } | null;
  title: string;
  description?: string | null;
}

export interface ApiOnboardingPrompt {
  id: string;
  type: number;
  options: ApiOnboardingPromptOption[];
  title: string;
  single_select: boolean;
  required: boolean;
  in_onboarding: boolean;
}

export interface ApiOnboarding {
  guild_id: string;
  prompts: ApiOnboardingPrompt[];
  default_channel_ids: string[];
  enabled: boolean;
  mode: number;
}

/** PUT /guilds/{id}/onboarding body (discord-api-types v10 verified shape). */
export interface OnboardingPutBody {
  prompts: Array<{
    id: string; // required by the API; reuse existing or generate
    title: string;
    single_select?: boolean | undefined;
    required?: boolean | undefined;
    in_onboarding?: boolean | undefined;
    type: number;
    options: Array<{
      id?: string | undefined;
      channel_ids?: string[] | undefined;
      role_ids?: string[] | undefined;
      title: string;
      description?: string | null | undefined;
      emoji_animated?: boolean | undefined;
      emoji_id?: string | null | undefined;
      emoji_name?: string | null | undefined;
    }>;
  }>;
  default_channel_ids: string[];
  enabled: boolean;
  mode?: number | undefined;
}

/** PATCH /guilds/{id} body — subset of mutable fields managed by `create`. */
export interface GuildPatchBody {
  name?: string | undefined;
  verification_level?: number | undefined;
  explicit_content_filter?: number | undefined;
  default_message_notifications?: number | undefined;
  preferred_locale?: string | undefined;
  features?: string[] | undefined;
  rules_channel_id?: string | null | undefined;
  public_updates_channel_id?: string | null | undefined;
}

/** POST /guilds/{id}/roles body (no `position` exists on create). */
export interface RoleCreateBody {
  name: string;
  permissions?: string | undefined;
  color?: number | undefined;
  hoist?: boolean | undefined;
  icon?: string | null | undefined;
  unicode_emoji?: string | null | undefined;
  mentionable?: boolean | undefined;
}

/** PATCH /guilds/{id}/roles/{roleId} body. */
export interface RolePatchBody {
  name?: string | undefined;
  permissions?: string | undefined;
  color?: number | undefined;
  hoist?: boolean | undefined;
  icon?: string | null | undefined;
  unicode_emoji?: string | null | undefined;
  mentionable?: boolean | undefined;
}

/** A single entry of the bulk PATCH /guilds/{id}/roles body. */
export interface RolePositionEntry {
  id: string;
  position?: number | undefined;
}

/** POST /guilds/{id}/channels body. */
export interface ChannelCreateBody {
  name: string;
  type?: number | undefined;
  topic?: string | null | undefined;
  bitrate?: number | undefined;
  user_limit?: number | undefined;
  rate_limit_per_user?: number | undefined;
  position?: number | undefined;
  permission_overwrites?: ApiPermissionOverwrite[] | undefined;
  parent_id?: string | undefined;
  nsfw?: boolean | undefined;
  default_auto_archive_duration?: number | undefined;
  video_quality_mode?: number | undefined;
  available_tags?: ChannelTagBody[] | undefined;
}

/** A forum tag in a create/patch body. */
export interface ChannelTagBody {
  id?: string | undefined;
  name: string;
  emoji_id?: string | null | undefined;
  emoji_name?: string | null | undefined;
  moderated?: boolean | undefined;
}

/** PATCH /channels/{id} body — mutable subset managed by `create`. */
export interface ChannelPatchBody {
  name?: string | undefined;
  topic?: string | null | undefined;
  bitrate?: number | undefined;
  user_limit?: number | undefined;
  rate_limit_per_user?: number | undefined;
  permission_overwrites?: ApiPermissionOverwrite[] | null | undefined;
  parent_id?: string | null | undefined;
  nsfw?: boolean | undefined;
  default_auto_archive_duration?: number | undefined;
  video_quality_mode?: number | undefined;
  available_tags?: ChannelTagBody[] | undefined;
}

/** A single entry of the bulk PATCH /guilds/{id}/channels body. */
export interface ChannelPositionEntry {
  id: string;
  position?: number | undefined;
}
