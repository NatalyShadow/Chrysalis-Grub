import type { DiscordPort } from "../port/discord-port.js";
import type {
  ApiChannel,
  ApiGuild,
  ApiOnboarding,
  ApiRole,
  ChannelCreateBody,
  ChannelPatchBody,
  ChannelPositionEntry,
  GuildPatchBody,
  OnboardingPutBody,
  RoleCreateBody,
  RolePatchBody,
  RolePositionEntry,
} from "../port/discord-types.js";

/**
 * Fake Discord API — in-memory guild state machine (testing.md §2/§3).
 *
 * Test-only; production code never imports it. Implements the same port with
 * the same response shapes as the REST adapter, including HTTP-style errors
 * and recorded calls for assertions.
 */

export interface FakeErrorConfig {
  /** Simulate 429 with retry-after when budget exhausted. */
  rateLimitBudget?: number;
  retryAfterMs?: number;
  /** Simulate a 5xx failure on the next updateOnboarding call. */
  failNextUpdate?: boolean;
  /** Create the resource remotely, then fail before the caller receives it. */
  failAfterCreateRole?: boolean;
  failAfterCreateChannel?: boolean;
}

export type FakeChannel = ApiChannel;

export class FakeDiscord implements DiscordPort {
  public guild: ApiGuild;
  public channels: FakeChannel[] = [];
  public roles: ApiRole[] = [];
  public onboarding: ApiOnboarding;

  /** Recorded calls for assertions. */
  public updates: OnboardingPutBody[] = [];
  public updateReasons: string[] = [];
  public reads = { getOnboarding: 0, listChannels: 0, listRoles: 0, getGuild: 0 };
  /** Recorded provisioning calls (clone flow). */
  public guildPatches: GuildPatchBody[] = [];
  public createdRoles: ApiRole[] = [];
  public rolePatches: Array<{ roleId: string; patch: RolePatchBody }> = [];
  public rolePositionPatches: RolePositionEntry[][] = [];
  public createdChannels: ApiChannel[] = [];
  public channelPatches: Array<{ channelId: string; patch: ChannelPatchBody }> = [];
  public channelPositionPatches: ChannelPositionEntry[][] = [];

  private nextId = 1000;

  private rateLimitBudgetLeft: number | null;
  private retryAfterMs: number;
  private failNextUpdate: boolean;
  private failAfterCreateRole: boolean;
  private failAfterCreateChannel: boolean;

  constructor(seed: {
    guild: ApiGuild;
    channels?: FakeChannel[];
    roles?: ApiRole[];
    onboarding?: ApiOnboarding;
    config?: FakeErrorConfig;
  }) {
    this.guild = seed.guild;
    this.channels = seed.channels ?? [];
    this.roles = seed.roles ?? [];
    this.onboarding =
      seed.onboarding ??
      ({
        guild_id: seed.guild.id,
        prompts: [],
        default_channel_ids: [],
        enabled: false,
        mode: 0,
      } satisfies ApiOnboarding);
    this.rateLimitBudgetLeft = seed.config?.rateLimitBudget ?? null;
    this.retryAfterMs = seed.config?.retryAfterMs ?? 1000;
    this.failNextUpdate = seed.config?.failNextUpdate ?? false;
    this.failAfterCreateRole = seed.config?.failAfterCreateRole ?? false;
    this.failAfterCreateChannel = seed.config?.failAfterCreateChannel ?? false;
  }

  async getGuild(guildId: string): Promise<ApiGuild> {
    this.reads.getGuild += 1;
    if (this.guild.id !== guildId) throw new FakeApiError(10004, "Unknown Guild");
    return structuredClone(this.guild);
  }

  async listChannels(guildId: string): Promise<ApiChannel[]> {
    this.reads.listChannels += 1;
    this.assertGuild(guildId);
    this.consumeBudget();
    return structuredClone(this.channels);
  }

  async listRoles(guildId: string): Promise<ApiRole[]> {
    this.reads.listRoles += 1;
    this.assertGuild(guildId);
    return structuredClone(this.roles);
  }

  async getOnboarding(guildId: string): Promise<ApiOnboarding> {
    this.reads.getOnboarding += 1;
    this.assertGuild(guildId);
    return structuredClone(this.onboarding);
  }

  async updateOnboarding(
    guildId: string,
    body: OnboardingPutBody,
    reason: string,
  ): Promise<ApiOnboarding> {
    this.assertGuild(guildId);
    this.consumeBudget();
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new FakeApiError(500, "Internal Server Error");
    }
    this.updates.push(structuredClone(body));
    this.updateReasons.push(reason);

    // Server-like id handling: prompts/options that already exist in the live
    // state keep their id; genuinely new ones get a fresh generated id.
    const now = BigInt(Date.now());
    const prompts = body.prompts.map((prompt, pIndex) => {
      const existingPrompt = this.onboarding.prompts.find(
        (p) => p.id === prompt.id || p.title === prompt.title,
      );
      const promptId = existingPrompt?.id ?? `fake-prompt-${now}-${pIndex}`;
      const usedOptionIds = new Set(existingPrompt?.options.map((o) => o.id) ?? []);
      return {
        id: promptId,
        title: prompt.title,
        single_select: prompt.single_select ?? false,
        required: prompt.required ?? false,
        in_onboarding: prompt.in_onboarding ?? true,
        type: prompt.type,
        options: prompt.options.map((option, oIndex) => {
          const existingOption = existingPrompt?.options.find(
            (o) => o.id === option.id || o.title === option.title,
          );
          let optionId = existingOption?.id;
          if (!optionId) {
            optionId = `fake-option-${now}-${pIndex}-${oIndex}`;
            while (usedOptionIds.has(optionId)) {
              optionId = `${optionId}-${Math.floor(Math.random() * 1000)}`;
            }
            usedOptionIds.add(optionId);
          }
          return {
            id: optionId,
            title: option.title,
            description: option.description ?? null,
            // The real API accepts the flat PUT fields but returns a nested
            // `emoji` object — mirror that asymmetry.
            emoji:
              option.emoji_id !== undefined || option.emoji_name !== undefined
                ? {
                    id: option.emoji_id ?? null,
                    name: option.emoji_name ?? null,
                    animated: option.emoji_animated ?? false,
                  }
                : null,
            channel_ids: option.channel_ids ?? [],
            role_ids: option.role_ids ?? [],
          };
        }),
      };
    });

    this.onboarding = {
      guild_id: guildId,
      prompts,
      default_channel_ids: [...body.default_channel_ids].sort(),
      enabled: body.enabled,
      mode: body.mode ?? 0,
    };
    return structuredClone(this.onboarding);
  }

  async updateGuild(guildId: string, body: GuildPatchBody, _reason: string): Promise<ApiGuild> {
    this.assertGuild(guildId);
    // Server-like semantics: PATCH only touches the provided fields; the rest
    // of the guild carries over untouched.
    this.guild = {
      ...this.guild,
      name: body.name ?? this.guild.name,
      features: body.features ?? this.guild.features,
      ...(body.verification_level !== undefined
        ? { verification_level: body.verification_level }
        : {}),
      ...(body.explicit_content_filter !== undefined
        ? { explicit_content_filter: body.explicit_content_filter }
        : {}),
      ...(body.default_message_notifications !== undefined
        ? { default_message_notifications: body.default_message_notifications }
        : {}),
      ...(body.preferred_locale !== undefined ? { preferred_locale: body.preferred_locale } : {}),
      ...(body.rules_channel_id !== undefined ? { rules_channel_id: body.rules_channel_id } : {}),
      ...(body.public_updates_channel_id !== undefined
        ? { public_updates_channel_id: body.public_updates_channel_id }
        : {}),
    };
    this.guildPatches.push(structuredClone(body));
    return structuredClone(this.guild);
  }

  async createRole(guildId: string, body: RoleCreateBody, _reason: string): Promise<ApiRole> {
    this.assertGuild(guildId);
    // Discord-like semantics: a freshly created role sits at the TOP of the
    // role list (highest position among non-managed roles), so created roles
    // do not accidentally match the desired order before a reorder op.
    const maxPosition = this.roles.reduce(
      (max, role) => (role.managed ? max : Math.max(max, role.position ?? 0)),
      0,
    );
    const role: ApiRole = {
      id: String(this.nextId++),
      name: body.name,
      permissions: body.permissions ?? "0",
      color: body.color ?? 0,
      hoist: body.hoist ?? false,
      mentionable: body.mentionable ?? false,
      position: maxPosition + 1,
      managed: false,
      icon: body.icon ?? null,
      unicode_emoji: body.unicode_emoji ?? null,
    };
    this.roles.push(role);
    this.createdRoles.push(structuredClone(role));
    if (this.failAfterCreateRole) {
      this.failAfterCreateRole = false;
      throw new FakeApiError(500, "Internal Server Error after role creation");
    }
    return structuredClone(role);
  }

  async updateRole(
    guildId: string,
    roleId: string,
    body: RolePatchBody,
    _reason: string,
  ): Promise<ApiRole> {
    this.assertGuild(guildId);
    const role = this.roles.find((candidate) => candidate.id === roleId);
    if (!role) throw new FakeApiError(10011, "Unknown Role");
    Object.assign(role, body);
    this.rolePatches.push({ roleId, patch: structuredClone(body) });
    return structuredClone(role);
  }

  async updateRolePositions(
    guildId: string,
    entries: RolePositionEntry[],
    _reason: string,
  ): Promise<ApiRole[]> {
    this.assertGuild(guildId);
    this.rolePositionPatches.push(structuredClone(entries));
    const byId = new Map(this.roles.map((role) => [role.id, role]));
    const ordered: ApiRole[] = [];
    for (const entry of entries) {
      const role = byId.get(entry.id);
      if (!role) throw new FakeApiError(10011, "Unknown Role");
      role.position = entry.position ?? 0;
      ordered.push(role);
    }
    // Roles not listed keep their position; @everyone always stays last.
    for (const role of this.roles) {
      if (!ordered.includes(role)) ordered.push(role);
    }
    this.roles = ordered;
    return structuredClone(this.roles);
  }

  async createChannel(
    guildId: string,
    body: ChannelCreateBody,
    _reason: string,
  ): Promise<ApiChannel> {
    this.assertGuild(guildId);
    const channel: ApiChannel = {
      id: String(this.nextId++),
      name: body.name,
      type: body.type ?? 0,
      permission_overwrites: body.permission_overwrites
        ? structuredClone(body.permission_overwrites)
        : [],
      parent_id: body.parent_id ?? null,
      position: this.channels.filter((candidate) => candidate.parent_id === body.parent_id).length,
      topic: body.topic ?? null,
      nsfw: body.nsfw ?? false,
      rate_limit_per_user: body.rate_limit_per_user ?? 0,
      bitrate: body.bitrate,
      user_limit: body.user_limit,
      video_quality_mode: body.video_quality_mode,
      default_auto_archive_duration: body.default_auto_archive_duration,
      available_tags: body.available_tags
        ? structuredClone(body.available_tags).map((tag) => ({
            ...tag,
            id: tag.id ?? `fake-tag-${this.nextId++}`,
          }))
        : undefined,
    };
    this.channels.push(channel);
    this.createdChannels.push(structuredClone(channel));
    if (this.failAfterCreateChannel) {
      this.failAfterCreateChannel = false;
      throw new FakeApiError(500, "Internal Server Error after channel creation");
    }
    return structuredClone(channel);
  }

  async updateChannel(
    guildId: string,
    channelId: string,
    body: ChannelPatchBody,
    _reason: string,
  ): Promise<ApiChannel> {
    this.assertGuild(guildId);
    const channel = this.channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw new FakeApiError(10003, "Unknown Channel");
    Object.assign(channel, body);
    this.channelPatches.push({ channelId, patch: structuredClone(body) });
    return structuredClone(channel);
  }

  async updateChannelPositions(
    guildId: string,
    entries: ChannelPositionEntry[],
    _reason: string,
  ): Promise<ApiChannel[]> {
    this.assertGuild(guildId);
    this.channelPositionPatches.push(structuredClone(entries));
    const byId = new Map(this.channels.map((channel) => [channel.id, channel]));
    for (const entry of entries) {
      const channel = byId.get(entry.id);
      if (!channel) throw new FakeApiError(10003, "Unknown Channel");
      channel.position = entry.position ?? 0;
    }
    return structuredClone(this.channels);
  }

  private assertGuild(guildId: string): void {
    if (this.guild.id !== guildId) throw new FakeApiError(10004, "Unknown Guild");
  }

  private consumeBudget(): void {
    if (this.rateLimitBudgetLeft === null) return;
    if (this.rateLimitBudgetLeft <= 0) {
      throw new FakeRateLimitError(this.retryAfterMs);
    }
    this.rateLimitBudgetLeft -= 1;
  }
}

export class FakeApiError extends Error {
  public readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "FakeApiError";
    this.code = code;
  }
}

export class FakeRateLimitError extends Error {
  public readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Fake 429 Too Many Requests");
    this.name = "FakeRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
