import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

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
 * REST adapter — maps port calls to @discordjs/rest + Routes (testing.md §3).
 * Thin: no business logic. Raw REST JSON is normalized upstream (reconciliation.md §4.4).
 *
 * REST-only: no Client, no gateway. 429s are queued by @discordjs/rest
 * (rejectOnRateLimit: null, verified for 2.6.3 — no retryBackoff exists;
 * retries: 3 covers 5xx/timeouts).
 */
export class RestDiscord implements DiscordPort {
  private readonly rest: REST;

  constructor(token: string) {
    this.rest = new REST({
      version: "10",
      globalRequestsPerSecond: 50,
      offset: 50,
      retries: 3,
      timeout: 30_000,
      rejectOnRateLimit: null,
      invalidRequestWarningInterval: 500,
      userAgentAppendix: "chrysalis-reconciler/0.1",
    });
    this.rest.setToken(token);
  }

  async getGuild(guildId: string): Promise<ApiGuild> {
    return (await this.rest.get(Routes.guild(guildId))) as ApiGuild;
  }

  async listChannels(guildId: string): Promise<ApiChannel[]> {
    return (await this.rest.get(Routes.guildChannels(guildId))) as ApiChannel[];
  }

  async listRoles(guildId: string): Promise<ApiRole[]> {
    return (await this.rest.get(Routes.guildRoles(guildId))) as ApiRole[];
  }

  async getOnboarding(guildId: string): Promise<ApiOnboarding> {
    return (await this.rest.get(Routes.guildOnboarding(guildId))) as ApiOnboarding;
  }

  async updateOnboarding(
    guildId: string,
    body: OnboardingPutBody,
    reason: string,
  ): Promise<ApiOnboarding> {
    return (await this.rest.put(Routes.guildOnboarding(guildId), {
      body,
      reason,
    })) as ApiOnboarding;
  }

  async updateGuild(guildId: string, body: GuildPatchBody, reason: string): Promise<ApiGuild> {
    return (await this.rest.patch(Routes.guild(guildId), { body, reason })) as ApiGuild;
  }

  async createRole(guildId: string, body: RoleCreateBody, reason: string): Promise<ApiRole> {
    return (await this.rest.post(Routes.guildRoles(guildId), { body, reason })) as ApiRole;
  }

  async updateRole(
    guildId: string,
    roleId: string,
    body: RolePatchBody,
    reason: string,
  ): Promise<ApiRole> {
    return (await this.rest.patch(Routes.guildRole(guildId, roleId), {
      body,
      reason,
    })) as ApiRole;
  }

  async updateRolePositions(
    guildId: string,
    entries: RolePositionEntry[],
    reason: string,
  ): Promise<ApiRole[]> {
    return (await this.rest.patch(Routes.guildRoles(guildId), {
      body: entries,
      reason,
    })) as ApiRole[];
  }

  async createChannel(
    guildId: string,
    body: ChannelCreateBody,
    reason: string,
  ): Promise<ApiChannel> {
    return (await this.rest.post(Routes.guildChannels(guildId), { body, reason })) as ApiChannel;
  }

  async updateChannel(
    _guildId: string,
    channelId: string,
    body: ChannelPatchBody,
    reason: string,
  ): Promise<ApiChannel> {
    return (await this.rest.patch(Routes.channel(channelId), { body, reason })) as ApiChannel;
  }

  async updateChannelPositions(
    guildId: string,
    entries: ChannelPositionEntry[],
    reason: string,
  ): Promise<ApiChannel[]> {
    return (await this.rest.patch(Routes.guildChannels(guildId), {
      body: entries,
      reason,
    })) as ApiChannel[];
  }
}
