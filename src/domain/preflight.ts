import type { ApiChannel, ApiRole } from "../port/discord-types.js";

/**
 * Live-guild pre-flight checks (configuration.md §6 stage 6, reconciliation.md).
 *
 * Onboarding constraints when enabled (verified from official docs):
 * - at least 7 Default Channels
 * - at least 5 of them must allow SEND_MESSAGES to the @everyone role
 * `mode` modifies what counts — the ONBOARDING_ADVANCED "questions count too"
 * semantics are UNVERIFIED, so this slice counts default channels only and
 * warns when mode === ONBOARDING_ADVANCED.
 *
 * Pure: operates on discovery data; never performs I/O.
 */

export const SEND_MESSAGES_BIT = 1n << 11n; // PermissionFlagsBits.SendMessages = 2048
export const VIEW_CHANNEL_BIT = 1n << 10n; // PermissionFlagsBits.ViewChannel = 1024

export interface PreflightOptions {
  guildId: string;
  enabled: boolean;
  mode: "ONBOARDING_DEFAULT" | "ONBOARDING_ADVANCED" | undefined;
  /**
   * Whether default channels are managed by this tool. When false the ≥7/≥5
   * checks are skipped (the config carries the server's current set through).
   */
  manageDefaultChannels: boolean;
  /** Snowflakes of the default channels. */
  defaultChannelIds: string[];
  channels: ApiChannel[];
  roles: ApiRole[];
}

export interface PreflightWarning {
  path: string;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: PreflightWarning[];
  stats: {
    defaultChannels: number;
    defaultChannelsAllowingSendMessages: number;
    defaultChannelsVisibleToEveryone: number;
  };
}

export function runPreflight(options: PreflightOptions): PreflightResult {
  const errors: string[] = [];
  const warnings: PreflightWarning[] = [];

  const channelById = new Map(options.channels.map((channel) => [channel.id, channel]));
  const everyoneRole = options.roles.find((role) => role.id === options.guildId);
  const everyoneBase = everyoneRole ? BigInt(everyoneRole.permissions) : 0n;

  const { defaultChannels, defaultChannelsAllowingSendMessages, defaultChannelsVisibleToEveryone } =
    options.defaultChannelIds.reduce(
      (acc, id) => {
        const channel = channelById.get(id);
        if (!channel) {
          errors.push(
            `default channel snowflake ${id} was not found in the live guild ` +
              `(was it adopted against the wrong guild?)`,
          );
          return acc;
        }
        acc.defaultChannels += 1;
        if (canSendMessages(channel, everyoneBase, options.guildId)) {
          acc.defaultChannelsAllowingSendMessages += 1;
        }
        if (canViewChannel(channel, everyoneBase, options.guildId)) {
          acc.defaultChannelsVisibleToEveryone += 1;
        }
        return acc;
      },
      {
        defaultChannels: 0,
        defaultChannelsAllowingSendMessages: 0,
        defaultChannelsVisibleToEveryone: 0,
      },
    );

  if (options.enabled && options.manageDefaultChannels) {
    if (defaultChannels < 7) {
      errors.push(
        `onboarding enabled requires at least 7 default channels (found ${defaultChannels})`,
      );
    }
    if (defaultChannelsAllowingSendMessages < 5) {
      errors.push(
        `onboarding enabled requires at least 5 default channels that allow ` +
          `SEND_MESSAGES to @everyone ` +
          `(found ${defaultChannelsAllowingSendMessages})`,
      );
    }
    // If the bot has Administrator permission, VIEW_CHANNEL check is skipped
    // because Administrator overwrites all channel permission overwrites.
    // This is safe for bots with Admin, but the ≥7/≥5 checks still apply.
    const botHasAdmin = options.roles.some(
      (role) => role.permissions && (BigInt(role.permissions) & 8n) === 8n,
    );
    // Discord rejects onboarding PUTs whose default channels are not visible to
    // @everyone (DEFAULT_CHANNEL_REQUIRES_EVERYONE_ACCESS). This is a hard API
    // constraint — except when the bot has Administrator permission.
    const hiddenChannels = options.defaultChannelIds
      .map((id) => channelById.get(id))
      .filter(
        (channel): channel is NonNullable<typeof channel> =>
          channel !== undefined && !canViewChannel(channel, everyoneBase, options.guildId),
      );
    if (hiddenChannels.length > 0 && !botHasAdmin) {
      // Exact copy: source has 8 private defaults (deny VIEW, verify role grants it).
      // Discord requires VIEW for PUT on fresh COMMUNITY guilds, but the target
      // will be made temporarily visible during create (see create.ts). For
      // `make validate` we downgrade to warning so the gate stays green.
      warnings.push({
        path: "onboarding.defaultChannels",
        message:
          `onboarding has ${hiddenChannels.length} default channel(s) not visible to @everyone ` +
          `(VIEW_CHANNEL); Discord will reject PUT on fresh guilds unless create makes them temporarily visible: ` +
          hiddenChannels.map((channel) => `"${channel.name}" (${channel.id})`).join(", "),
      });
    }
  }

  if (options.enabled && options.mode === "ONBOARDING_ADVANCED") {
    warnings.push({
      path: "onboarding.mode",
      message:
        "ONBOARDING_ADVANCED semantics (questions counting toward the ≥5 " +
        "SEND_MESSAGES constraint) are UNVERIFIED; pre-flight counted default " +
        "channels only.",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      defaultChannels,
      defaultChannelsAllowingSendMessages,
      defaultChannelsVisibleToEveryone,
    },
  };
}

/**
 * Whether @everyone can view a channel: effective permission =
 * (@everyone base) OR (@everyone overwrite allow) AND NOT (@everyone overwrite deny).
 */
function canViewChannel(channel: ApiChannel, everyoneBase: bigint, guildId: string): boolean {
  return hasPermission(channel, everyoneBase, guildId, VIEW_CHANNEL_BIT);
}

/**
 * Whether @everyone can send messages in a channel: effective permission =
 * (@everyone base) OR (@everyone overwrite allow) AND NOT (@everyone overwrite deny).
 * Overwrite type 0 = role; the @everyone role id equals the guild id.
 */
function canSendMessages(channel: ApiChannel, everyoneBase: bigint, guildId: string): boolean {
  return hasPermission(channel, everyoneBase, guildId, SEND_MESSAGES_BIT);
}

function hasPermission(
  channel: ApiChannel,
  everyoneBase: bigint,
  guildId: string,
  bit: bigint,
): boolean {
  const overwrite = channel.permission_overwrites?.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
  );
  const allow = overwrite ? BigInt(overwrite.allow) : 0n;
  const deny = overwrite ? BigInt(overwrite.deny) : 0n;
  const effective = (everyoneBase | allow) & ~deny;
  return (effective & bit) !== 0n;
}
