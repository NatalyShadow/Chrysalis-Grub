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

  private async wrap<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      // Preserve Discord status/code for upstream CreateError wrapping
      // (plan: rest error mapping). @discordjs/rest throws DiscordAPIError
      // with .status/.code; enrich message so create.ts logs include it.
      if (error !== null && typeof error === "object" && "status" in error) {
        const status = (error as Record<string, unknown>).status;
        const code = (error as Record<string, unknown>).code;
        const message = error instanceof Error ? error.message : String(error);
        const enriched = new Error(
          `${message}${status !== undefined ? ` (status ${String(status)})` : ""}${code !== undefined ? ` code ${String(code)}` : ""}`,
        );
        (enriched as unknown as Record<string, unknown>).cause = error;
        (enriched as unknown as Record<string, unknown>).status = status;
        (enriched as unknown as Record<string, unknown>).code = code;
        throw enriched;
      }
      throw error;
    }
  }

  async getGuild(guildId: string): Promise<ApiGuild> {
    return this.wrap(async () => (await this.rest.get(Routes.guild(guildId))) as ApiGuild);
  }

  async listChannels(guildId: string): Promise<ApiChannel[]> {
    return this.wrap(
      async () => (await this.rest.get(Routes.guildChannels(guildId))) as ApiChannel[],
    );
  }

  async listRoles(guildId: string): Promise<ApiRole[]> {
    return this.wrap(async () => (await this.rest.get(Routes.guildRoles(guildId))) as ApiRole[]);
  }

  async getOnboarding(guildId: string): Promise<ApiOnboarding> {
    return this.wrap(
      async () => (await this.rest.get(Routes.guildOnboarding(guildId))) as ApiOnboarding,
    );
  }

  async updateOnboarding(
    guildId: string,
    body: OnboardingPutBody,
    reason: string,
  ): Promise<ApiOnboarding> {
    return this.wrap(
      async () =>
        (await this.rest.put(Routes.guildOnboarding(guildId), {
          body,
          reason,
        })) as ApiOnboarding,
    );
  }

  async updateGuild(guildId: string, body: GuildPatchBody, reason: string): Promise<ApiGuild> {
    return this.wrap(
      async () => (await this.rest.patch(Routes.guild(guildId), { body, reason })) as ApiGuild,
    );
  }

  async createRole(guildId: string, body: RoleCreateBody, reason: string): Promise<ApiRole> {
    return this.wrap(
      async () => (await this.rest.post(Routes.guildRoles(guildId), { body, reason })) as ApiRole,
    );
  }

  async updateRole(
    guildId: string,
    roleId: string,
    body: RolePatchBody,
    reason: string,
  ): Promise<ApiRole> {
    return this.wrap(
      async () =>
        (await this.rest.patch(Routes.guildRole(guildId, roleId), {
          body,
          reason,
        })) as ApiRole,
    );
  }

  async updateRolePositions(
    guildId: string,
    entries: RolePositionEntry[],
    reason: string,
  ): Promise<ApiRole[]> {
    return this.wrap(
      async () =>
        (await this.rest.patch(Routes.guildRoles(guildId), {
          body: entries,
          reason,
        })) as ApiRole[],
    );
  }

  async createChannel(
    guildId: string,
    body: ChannelCreateBody,
    reason: string,
  ): Promise<ApiChannel> {
    return this.wrap(
      async () =>
        (await this.rest.post(Routes.guildChannels(guildId), { body, reason })) as ApiChannel,
    );
  }

  async updateChannel(
    _guildId: string,
    channelId: string,
    body: ChannelPatchBody,
    reason: string,
  ): Promise<ApiChannel> {
    return this.wrap(
      async () =>
        (await this.rest.patch(Routes.channel(channelId), { body, reason })) as ApiChannel,
    );
  }

  async updateChannelPositions(
    guildId: string,
    entries: ChannelPositionEntry[],
    reason: string,
  ): Promise<ApiChannel[]> {
    return this.wrap(
      async () =>
        (await this.rest.patch(Routes.guildChannels(guildId), {
          body: entries,
          reason,
        })) as ApiChannel[],
    );
  }
}
