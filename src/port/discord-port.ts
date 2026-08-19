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
} from "./discord-types.js";

/**
 * DiscordPort — the seam between domain and Discord (testing.md §3).
 *
 * Defined in APP types only (never discord.js). Production: rest-adapter.
 * Tests: fake-adapter (in-memory guild state machine). Production code never
 * imports the fake; test code never touches discord.js.
 */
export interface DiscordPort {
  getGuild(guildId: string): Promise<ApiGuild>;
  listChannels(guildId: string): Promise<ApiChannel[]>;
  listRoles(guildId: string): Promise<ApiRole[]>;
  getOnboarding(guildId: string): Promise<ApiOnboarding>;
  updateOnboarding(
    guildId: string,
    body: OnboardingPutBody,
    reason: string,
  ): Promise<ApiOnboarding>;

  // --- create/provision surface (clone flow, docs/clone-server.md) ---

  /** PATCH /guilds/{id} — base settings and/or the COMMUNITY toggle. */
  updateGuild(guildId: string, body: GuildPatchBody, reason: string): Promise<ApiGuild>;
  /** POST /guilds/{id}/roles — no `position` (positions via updateRolePositions). */
  createRole(guildId: string, body: RoleCreateBody, reason: string): Promise<ApiRole>;
  /** PATCH /guilds/{id}/roles/{roleId}. */
  updateRole(
    guildId: string,
    roleId: string,
    body: RolePatchBody,
    reason: string,
  ): Promise<ApiRole>;
  /** Bulk PATCH /guilds/{id}/roles — ordering. */
  updateRolePositions(
    guildId: string,
    entries: RolePositionEntry[],
    reason: string,
  ): Promise<ApiRole[]>;
  /** POST /guilds/{id}/channels. */
  createChannel(guildId: string, body: ChannelCreateBody, reason: string): Promise<ApiChannel>;
  /** PATCH /channels/{id}. */
  updateChannel(
    guildId: string,
    channelId: string,
    body: ChannelPatchBody,
    reason: string,
  ): Promise<ApiChannel>;
  /** Bulk PATCH /guilds/{id}/channels — ordering (position-only; no parent moves). */
  updateChannelPositions(
    guildId: string,
    entries: ChannelPositionEntry[],
    reason: string,
  ): Promise<ApiChannel[]>;
}
