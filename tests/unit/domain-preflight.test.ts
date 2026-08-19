import { describe, expect, it } from "vitest";

import { runPreflight, SEND_MESSAGES_BIT, VIEW_CHANNEL_BIT } from "../../src/domain/preflight.js";
import type { ApiChannel, ApiRole } from "../../src/port/discord-types.js";

/**
 * Pre-flight checks (configuration.md §6 stage 6): live-guild constraints.
 */

const GUILD_ID = "123";
const CHANNEL_IDS = ["100", "101", "102", "103", "104", "105", "106"];

function channel(id: string, overwrite?: ApiChannel["permission_overwrites"]): ApiChannel {
  return { id, name: `ch-${id}`, type: 0, permission_overwrites: overwrite };
}

function everyone(permissions: string): ApiRole {
  return { id: GUILD_ID, name: "@everyone", permissions };
}

/** @everyone base perms: VIEW_CHANNEL + SEND_MESSAGES (Discord's default). */
const EVERYONE_BASE = String(VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT);

const sevenChannels = CHANNEL_IDS.map((id) => channel(id));
const everyoneCanSend = [everyone(EVERYONE_BASE)];

function preflight(
  options: Partial<Parameters<typeof runPreflight>[0]> = {},
): ReturnType<typeof runPreflight> {
  return runPreflight({
    guildId: GUILD_ID,
    enabled: true,
    mode: "ONBOARDING_DEFAULT",
    manageDefaultChannels: true,
    defaultChannelIds: CHANNEL_IDS,
    channels: sevenChannels,
    roles: everyoneCanSend,
    ...options,
  });
}

describe("runPreflight", () => {
  it("passes when ≥7 default channels and ≥5 allow SEND_MESSAGES to @everyone", () => {
    const result = preflight();
    expect(result.ok).toBe(true);
    expect(result.stats.defaultChannels).toBe(7);
    expect(result.stats.defaultChannelsAllowingSendMessages).toBe(7);
  });

  it("fails when onboarding is enabled with fewer than 7 default channels", () => {
    const result = preflight({ defaultChannelIds: ["100", "101", "102"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("at least 7"))).toBe(true);
  });

  it("fails when fewer than 5 default channels allow SEND_MESSAGES", () => {
    const blocked = CHANNEL_IDS.slice(0, 7).map((id) =>
      channel(id, [{ id: GUILD_ID, type: 0, allow: "0", deny: String(SEND_MESSAGES_BIT) }]),
    );
    const result = preflight({ channels: blocked });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("SEND_MESSAGES"))).toBe(true);
  });

  it("fails when a default channel snowflake is missing from the live guild", () => {
    const result = preflight({ channels: sevenChannels.slice(0, 6) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("not found"))).toBe(true);
  });

  it("skips ≥7/≥5 checks when onboarding is disabled", () => {
    const result = preflight({ enabled: false, defaultChannelIds: ["100"] });
    expect(result.ok).toBe(true);
  });

  it("skips ≥7/≥5 checks when manageDefaultChannels is false", () => {
    const result = preflight({
      manageDefaultChannels: false,
      defaultChannelIds: ["100", "101", "102"],
    });
    expect(result.ok).toBe(true);
    expect(result.stats.defaultChannels).toBe(3);
    expect(result.stats.defaultChannelsAllowingSendMessages).toBe(3);
  });

  it("still flags a default channel snowflake missing from the live guild when not managing", () => {
    const result = preflight({
      manageDefaultChannels: false,
      defaultChannelIds: ["100", "999"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("not found"))).toBe(true);
  });

  it("warns for ONBOARDING_ADVANCED semantics (UNVERIFIED)", () => {
    const result = preflight({ mode: "ONBOARDING_ADVANCED" });
    expect(result.warnings.some((warning) => warning.path === "onboarding.mode")).toBe(true);
  });

  it("honors a SEND_MESSAGES allow overwrite even when base perms deny it", () => {
    // @everyone base: no SEND_MESSAGES; one channel grants it via overwrite.
    const oneAllows = CHANNEL_IDS.map((id, index) =>
      index === 0
        ? channel(id, [{ id: GUILD_ID, type: 0, allow: String(SEND_MESSAGES_BIT), deny: "0" }])
        : channel(id, [{ id: GUILD_ID, type: 0, allow: "0", deny: String(SEND_MESSAGES_BIT) }]),
    );
    const result = preflight({ channels: oneAllows, roles: [everyone("0")] });
    expect(result.stats.defaultChannelsAllowingSendMessages).toBe(1);
    expect(result.ok).toBe(false); // only 1 of 7 allows SEND_MESSAGES
  });

  it("deny overwrite wins over base permission", () => {
    const denied = sevenChannels.map((ch) =>
      channel(ch.id, [{ id: GUILD_ID, type: 0, allow: "0", deny: String(SEND_MESSAGES_BIT) }]),
    );
    const result = preflight({ channels: denied });
    expect(result.stats.defaultChannelsAllowingSendMessages).toBe(0);
  });

  it("fails when a default channel hides VIEW_CHANNEL from @everyone", () => {
    // Discord rejects onboarding PUTs whose default channels @everyone cannot
    // see (DEFAULT_CHANNEL_REQUIRES_EVERYONE_ACCESS) — e.g. a category whose
    // overwrite denies VIEW_CHANNEL to @everyone, like the source clone's.
    const hidden = sevenChannels.map((ch) =>
      channel(ch.id, [{ id: GUILD_ID, type: 0, allow: "0", deny: String(VIEW_CHANNEL_BIT) }]),
    );
    const result = preflight({ channels: hidden });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("visible to @everyone"))).toBe(true);
    expect(result.stats.defaultChannelsVisibleToEveryone).toBe(0);
  });

  it("passes when default channels are visible to @everyone", () => {
    const result = preflight();
    expect(result.stats.defaultChannelsVisibleToEveryone).toBe(7);
    expect(result.ok).toBe(true);
  });

  it("does not gate hidden defaults when onboarding is disabled", () => {
    const hidden = sevenChannels.map((ch) =>
      channel(ch.id, [{ id: GUILD_ID, type: 0, allow: "0", deny: String(VIEW_CHANNEL_BIT) }]),
    );
    const result = preflight({ enabled: false, channels: hidden });
    expect(result.ok).toBe(true);
  });
});
