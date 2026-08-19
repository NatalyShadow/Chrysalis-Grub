import type {
  ValidatedChannels,
  ValidatedGuildSettings,
  ValidatedRole,
  ValidatedRoles,
} from "../config/schema/onboarding.js";
import { EVERYONE_REF, type OnboardingMode, type OnboardingPromptType } from "../config/types.js";
import type { ManifestData } from "../identity/manifest.js";
import type { ApiChannel, ApiGuild, ApiOnboarding, ApiRole } from "../port/discord-types.js";

/**
 * Capture (docs/clone-server.md, Phase 1): read-only dump of the source guild
 * into ID-free config fragments (`guild`, `roles`, `channels`).
 *
 * Key strategy:
 * - Logical keys are BORROWED from the source manifest when a binding matches
 *   the live snowflake (so the curated onboarding refs keep working).
 * - Everything else gets a deterministic slug from its name (collision-safe).
 * - @everyone, managed (other-bot) roles and excluded-by-name resources are
 *   skipped and reported. Member overwrites (type 1) are dropped and counted.
 */

export interface CaptureOptions {
  guildId: string;
  guild: ApiGuild;
  roles: ApiRole[];
  channels: ApiChannel[];
  /** Onboarding data to capture (optional — absent guilds have none). */
  onboarding?: ApiOnboarding;
  /** Source-guild manifest — borrows logical keys from its bindings. */
  sourceManifest?: ManifestData | null;
  /** Roles to skip (exact names, case-insensitive) — e.g. other bots'. */
  excludeRoleNames?: ReadonlySet<string>;
  /** Channels to skip (exact names, case-insensitive) — e.g. SERVER STATS. */
  excludeChannelNames?: ReadonlySet<string>;
}

/** A captured onboarding prompt (written to `prompt-<key>.json`). */
export interface CapturedPrompt {
  key: string;
  title: string;
  type: OnboardingPromptType;
  singleSelect?: boolean;
  required?: boolean;
  inOnboarding?: boolean;
  separatorRole?: string;
  options: CapturedOption[];
}

/** A captured onboarding option (sub-resource of a prompt). */
export interface CapturedOption {
  key: string;
  title: string;
  description?: string;
  emoji?: string;
  roles?: string[];
  channels?: string[];
}

/** Captured onboarding: base fields (onboarding.json) + prompts (prompt-*.json). */
export interface CapturedOnboarding {
  base: {
    enabled: boolean;
    mode: OnboardingMode;
    manageDefaultChannels?: boolean;
    defaultChannels?: string[];
  };
  prompts: CapturedPrompt[];
}

export interface CaptureResult {
  guild: ValidatedGuildSettings;
  roles: ValidatedRoles;
  channels: ValidatedChannels;
  /** key → source snowflake (traceability; written to .chrysalis/clone-source.json). */
  sourceBindings: Record<string, string>;
  /** Roles skipped: @everyone, managed, or excluded by name. */
  skippedRoles: string[];
  /** Channels skipped by name. */
  skippedChannels: string[];
  /** @everyone overwrites kept (serialized as the special EVERYONE_REF). */
  everyoneOverwrites: number;
  /** Member overwrites (type 1) dropped — members are not cloned. */
  droppedMemberOverwrites: number;
  /** Overwrites referencing a skipped/uncaptured role dropped. */
  droppedRoleOverwrites: number;
  /** Captured onboarding (undefined when the guild has none). */
  onboarding?: CapturedOnboarding;
}

export function runCapture(options: CaptureOptions): CaptureResult {
  const usedKeys = new Map<string, number>();
  const sourceBindings: Record<string, string> = {};
  const skippedRoles: string[] = [];
  const skippedChannels: string[] = [];
  let droppedMemberOverwrites = 0;
  let droppedRoleOverwrites = 0;

  // Reverse index of the source manifest: snowflake → { kind, key }.
  const manifestIndex = new Map<string, { kind: "role" | "channel"; key: string }>();
  if (options.sourceManifest) {
    for (const binding of Object.values(options.sourceManifest.bindings)) {
      manifestIndex.set(binding.discordId, { kind: binding.kind, key: binding.key });
    }
  }

  const excludeRoles = normalizeSet(options.excludeRoleNames);
  const excludeChannels = normalizeSet(options.excludeChannelNames);

  // --- Roles ---
  const roleKeys = new Map<string, string>(); // roleId → key
  const roleNames = new Map<string, string>(); // roleId → display name (onboarding)
  const roles: ValidatedRole[] = [];
  const roleOrder: string[] = [];
  for (const role of options.roles) {
    if (role.id === options.guildId) {
      skippedRoles.push(`@everyone (${role.id})`);
      continue;
    }
    if (role.managed) {
      skippedRoles.push(`${role.name} (managed by another bot)`);
      continue;
    }
    if (excludeRoles.has(role.name.toLowerCase())) {
      skippedRoles.push(`${role.name} (excluded by name)`);
      continue;
    }
    const manifestEntry = manifestIndex.get(role.id);
    const borrowed = manifestEntry?.kind === "role" ? manifestEntry.key : undefined;
    const key = uniqueKey(borrowed ?? slugify(role.name), usedKeys);
    roleKeys.set(role.id, key);
    roleNames.set(role.id, role.name);
    sourceBindings[`roles.${key}`] = role.id;
    roles.push({
      key,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions,
      ...(role.icon ? { icon: role.icon } : {}),
      ...(role.unicode_emoji ? { unicodeEmoji: role.unicode_emoji } : {}),
    });
    roleOrder.push(key);
  }

  // --- Channels ---
  const channelKeys = new Map<string, string>(); // channelId → key
  const categories: ValidatedChannels["categories"] = [];
  const children: ValidatedChannels["channels"] = [];
  const channelOrder: string[] = [];
  let everyoneOverwrites = 0;

  // Excluding a category excludes its whole subtree (descendants by
  // parent_id) — e.g. the SERVER STATS category and its bot-maintained
  // counter voice channels.
  const excludedIds = new Set<string>();
  for (const channel of options.channels) {
    if (excludeChannels.has(channel.name.toLowerCase())) {
      excludedIds.add(channel.id);
    }
  }
  const pending = [...excludedIds];
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId) continue;
    for (const channel of options.channels) {
      if (channel.parent_id === parentId && !excludedIds.has(channel.id)) {
        excludedIds.add(channel.id);
        pending.push(channel.id);
      }
    }
  }

  for (const channel of options.channels) {
    if (excludedIds.has(channel.id)) {
      const insideCategory =
        channel.parent_id !== null &&
        channel.parent_id !== undefined &&
        excludedIds.has(channel.parent_id);
      skippedChannels.push(
        insideCategory
          ? `${channel.name} (inside excluded category)`
          : `${channel.name} (excluded by name)`,
      );
      continue;
    }
    const manifestEntry = manifestIndex.get(channel.id);
    const borrowed = manifestEntry?.kind === "channel" ? manifestEntry.key : undefined;
    const key = uniqueKey(borrowed ?? slugify(channel.name), usedKeys);
    channelKeys.set(channel.id, key);
    sourceBindings[`channels.${key}`] = channel.id;

    // Parent ref: only when the parent was captured too.
    let parent: string | undefined;
    if (channel.parent_id) {
      const parentKey = channelKeys.get(channel.parent_id);
      if (parentKey) parent = parentKey;
    }

    const entry = {
      key,
      name: channel.name,
      type: channel.type,
      ...(parent ? { parent } : {}),
      ...(channel.topic ? { topic: channel.topic } : {}),
      ...(channel.nsfw ? { nsfw: true } : {}),
      ...(channel.rate_limit_per_user && channel.rate_limit_per_user > 0
        ? { rateLimitPerUser: channel.rate_limit_per_user }
        : {}),
      ...(channel.bitrate && channel.bitrate > 0 ? { bitrate: channel.bitrate } : {}),
      ...(channel.user_limit && channel.user_limit > 0 ? { userLimit: channel.user_limit } : {}),
      ...(channel.video_quality_mode !== undefined
        ? { videoQualityMode: channel.video_quality_mode }
        : {}),
      ...(channel.default_auto_archive_duration !== undefined
        ? { defaultAutoArchiveDuration: channel.default_auto_archive_duration }
        : {}),
      ...(channel.available_tags && channel.available_tags.length > 0
        ? {
            availableTags: channel.available_tags.map((tag) => ({
              name: tag.name,
              ...(tag.emoji_name ? { emojiName: tag.emoji_name } : {}),
            })),
          }
        : {}),
      overwrites: mapOverwrites(
        channel.permission_overwrites ?? [],
        roleKeys,
        options.guildId,
        () => {
          everyoneOverwrites += 1;
        },
        () => {
          droppedMemberOverwrites += 1;
        },
        () => {
          droppedRoleOverwrites += 1;
        },
      ),
    };
    if (channel.type === 4) {
      categories?.push(entry);
    } else {
      children?.push(entry);
    }
    channelOrder.push(key);
  }

  // --- Guild settings ---
  const community =
    options.guild.features.includes("COMMUNITY") &&
    options.guild.rules_channel_id &&
    options.guild.public_updates_channel_id
      ? {
          ...(channelKeys.get(options.guild.rules_channel_id)
            ? { rulesChannel: channelKeys.get(options.guild.rules_channel_id) }
            : {}),
          ...(channelKeys.get(options.guild.public_updates_channel_id)
            ? { publicUpdatesChannel: channelKeys.get(options.guild.public_updates_channel_id) }
            : {}),
        }
      : undefined;
  const hasCommunityRefs = community?.rulesChannel && community?.publicUpdatesChannel;

  const guild: ValidatedGuildSettings = {
    ...(options.guild.name ? { name: options.guild.name } : {}),
    ...(options.guild.verification_level !== undefined
      ? { verificationLevel: options.guild.verification_level }
      : {}),
    ...(options.guild.explicit_content_filter !== undefined
      ? { explicitContentFilter: options.guild.explicit_content_filter }
      : {}),
    ...(options.guild.default_message_notifications !== undefined
      ? { defaultMessageNotifications: options.guild.default_message_notifications }
      : {}),
    ...(options.guild.preferred_locale ? { preferredLocale: options.guild.preferred_locale } : {}),
    ...(community && hasCommunityRefs ? { community } : {}),
  };

  // --- Onboarding ---
  const onboarding = options.onboarding
    ? captureOnboarding(options.onboarding, roleKeys, roleNames, channelKeys)
    : undefined;

  return {
    guild,
    roles: { roles, ordering: roleOrder },
    channels: {
      categories: categories ?? [],
      channels: children ?? [],
      ordering: channelOrder,
    },
    sourceBindings,
    skippedRoles,
    skippedChannels,
    everyoneOverwrites,
    droppedMemberOverwrites,
    droppedRoleOverwrites,
    ...(onboarding ? { onboarding } : {}),
  };
}

function mapOverwrites(
  overwrites: ApiChannel["permission_overwrites"],
  roleKeys: Map<string, string>,
  guildId: string,
  onEveryone: () => void,
  onMember: () => void,
  onDroppedRole: () => void,
): Array<{ ref: string; allow?: string; deny?: string }> {
  const out: Array<{ ref: string; allow?: string; deny?: string }> = [];
  for (const overwrite of overwrites ?? []) {
    if (overwrite.type === 1) {
      onMember();
      continue;
    }
    // @everyone is implicit in every guild (id === guildId): captured as the
    // special EVERYONE_REF and resolved back to the target guild id at create.
    if (overwrite.id === guildId) {
      out.push({ ref: EVERYONE_REF, allow: overwrite.allow, deny: overwrite.deny });
      onEveryone();
      continue;
    }
    const key = roleKeys.get(overwrite.id);
    if (!key) {
      onDroppedRole();
      continue;
    }
    out.push({
      ref: key,
      allow: overwrite.allow,
      deny: overwrite.deny,
    });
  }
  return out;
}

/** Case-insensitive set of names (lowercased). */
function normalizeSet(set?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const name of set ?? []) out.add(name.toLowerCase());
  return out;
}

/**
 * Capture the guild onboarding into ID-free fragments.
 *
 * Prompt key strategy: the SEPARATOR role (the role id shared by every option
 * of the prompt) names the prompt. Its display name (e.g. `GENDER`,
 * `COUNTRY`) is slugified to `gender`, `country`… matching the hand-authored
 * `config/cloneexample` keys. Option keys come from the option's non-separator
 * role key (e.g. `hombre`), falling back to a slug of the option title when
 * the option grants no specific role.
 */
function captureOnboarding(
  onboarding: ApiOnboarding,
  roleKeys: Map<string, string>,
  roleNames: Map<string, string>,
  channelKeys: Map<string, string>,
): CapturedOnboarding {
  const promptKeyUsage = new Map<string, number>();
  const prompts = onboarding.prompts.map((apiPrompt) => {
    // Separator role: the role id present in every option of the prompt.
    const separatorRoleId = findSeparatorRoleId(apiPrompt.options);
    const separatorKey = separatorRoleId ? roleKeys.get(separatorRoleId) : undefined;
    // Prompt key: slug of the separator role's display name (GENDER → gender),
    // falling back to the prompt title when the role is missing.
    const separatorName = separatorRoleId ? roleNames.get(separatorRoleId) : undefined;
    const promptKey = uniqueKey(
      separatorName ? slugify(separatorName) : slugify(apiPrompt.title),
      promptKeyUsage,
    );

    const optionKeyUsage = new Map<string, number>();
    const options = apiPrompt.options.map((option) => {
      // Option roles: every role except the separator.
      const specificRoleIds = option.role_ids.filter((id) => id !== separatorRoleId);
      const roleRefs = specificRoleIds
        .map((id) => roleKeys.get(id))
        .filter((key): key is string => key !== undefined);
      const primaryRoleKey = roleRefs[0];
      const channels = (option.channel_ids ?? [])
        .map((id) => channelKeys.get(id))
        .filter((key): key is string => key !== undefined);

      return {
        key: uniqueKey(primaryRoleKey ?? slugify(option.title), optionKeyUsage),
        title: option.title,
        ...(option.description ? { description: option.description } : {}),
        ...(option.emoji?.name ? { emoji: option.emoji.name } : {}),
        ...(roleRefs.length > 0 ? { roles: roleRefs } : {}),
        ...(channels.length > 0 ? { channels } : {}),
      };
    });

    const prompt: CapturedPrompt = {
      key: promptKey,
      title: apiPrompt.title,
      type: apiPrompt.type === 1 ? "DROPDOWN" : "MULTIPLE_CHOICE",
      ...(apiPrompt.single_select ? { singleSelect: true } : {}),
      ...(apiPrompt.required ? { required: true } : {}),
      ...(apiPrompt.in_onboarding ? { inOnboarding: true } : {}),
      ...(separatorKey !== undefined ? { separatorRole: separatorKey } : {}),
      options,
    };
    return prompt;
  });

  const defaultChannels = (onboarding.default_channel_ids ?? [])
    .map((id) => channelKeys.get(id))
    .filter((key): key is string => key !== undefined);

  return {
    base: {
      enabled: onboarding.enabled,
      mode: onboarding.mode === 1 ? "ONBOARDING_ADVANCED" : "ONBOARDING_DEFAULT",
      ...(defaultChannels.length > 0 ? { defaultChannels } : {}),
    },
    prompts,
  };
}

/**
 * The separator role of a prompt is the role id granted by EVERY option
 * (e.g. the gender role shared by all six gender options). Returns undefined
 * when no single role is shared by all options.
 */
function findSeparatorRoleId(
  options: ApiOnboarding["prompts"][number]["options"],
): string | undefined {
  const first = options[0];
  if (!first) return undefined;
  const candidates = first.role_ids.filter((id) =>
    options.every((option) => option.role_ids.includes(id)),
  );
  return candidates[0];
}

/** Deterministic key from a name; collision-safe with a numeric suffix. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "untitled" : slug;
}

function uniqueKey(base: string, used: Map<string, number>): string {
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (count === 0) return base;
  return `${base}-${count + 1}`;
}
