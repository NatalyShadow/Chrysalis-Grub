import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import { runCapture } from "../../src/engine/capture.js";
import type { ManifestData } from "../../src/identity/types.js";
import type { ApiChannel, ApiGuild, ApiOnboarding, ApiRole } from "../../src/port/discord-types.js";

const guildId = "123";
const guild = {
  id: guildId,
  name: "Grub NSFW",
  features: ["COMMUNITY"],
  verification_level: 2,
  explicit_content_filter: 2,
  default_message_notifications: 1,
  preferred_locale: "en-US",
  rules_channel_id: "400",
  public_updates_channel_id: "401",
};

function manifestWith(bindings: ManifestData["bindings"] = {}): ManifestData {
  return {
    meta: { schemaVersion: 1, guildId, createdAt: "x", deletionPolicy: "never" },
    bindings,
  };
}

function binding(kind: "role" | "channel", key: string, discordId: string) {
  return { key, aliases: [], kind, discordId, createdAt: "x" };
}

const roles = [
  { id: guildId, name: "@everyone", permissions: "0" }, // skipped
  { id: "201", name: "👑 Admin", permissions: "8", color: 16711680, hoist: true, managed: false },
  { id: "202", name: "arabic-race", permissions: "0", managed: false }, // borrowed key
  { id: "203", name: "ProBot", permissions: "0", managed: true }, // other bot
];

const channels = [
  { id: "300", name: "📋・INFORMATION", type: 4, permission_overwrites: [] },
  { id: "400", name: "rules", type: 0, parent_id: "300", permission_overwrites: [] },
  { id: "401", name: "moderator-only", type: 0, parent_id: "300", permission_overwrites: [] },
];

const sourceManifest = manifestWith({
  "roles.arabic-race": binding("role", "arabic-race", "202"),
  "channels.rules": binding("channel", "rules", "400"),
});

describe("runCapture", () => {
  it("borrows keys from the source manifest and skips @everyone + managed roles", () => {
    const result = runCapture({ guildId, guild, roles, channels, sourceManifest });

    // @everyone and ProBot skipped; Admin slugified; arabic-race borrowed.
    expect(result.skippedRoles).toEqual([
      `@everyone (${guildId})`,
      "ProBot (managed by another bot)",
    ]);
    const keys = result.roles.roles.map((role) => role.key);
    expect(keys).toContain("arabic-race");
    expect(keys).toContain("admin");
    expect(keys).toHaveLength(2);
    expect(result.sourceBindings["roles.arabic-race"]).toBe("202");
  });

  it("captures guild settings and the community refs to captured channels", () => {
    const result = runCapture({ guildId, guild, roles, channels, sourceManifest });

    expect(result.guild).toMatchObject({
      name: "Grub NSFW",
      verificationLevel: 2,
      explicitContentFilter: 2,
      defaultMessageNotifications: 1,
      preferredLocale: "en-US",
    });
    expect(result.guild.community).toEqual({
      rulesChannel: "rules",
      publicUpdatesChannel: "moderator-only",
    });
  });

  it("maps categories vs children and channel parents", () => {
    const result = runCapture({ guildId, guild, roles, channels, sourceManifest });

    expect(result.channels.categories?.map((c) => c.key)).toEqual(["information"]);
    expect(result.channels.channels?.map((c) => c.key).sort()).toEqual(["moderator-only", "rules"]);
    expect(result.channels.channels?.[0]?.parent).toBe("information");
  });

  it("drops member overwrites, keeps @everyone, drops overwrites of skipped roles", () => {
    const channelsWithOverwrites: ApiChannel[] = [
      { id: "300", name: "INFORMATION", type: 4, permission_overwrites: [] },
      {
        id: "400",
        name: "rules",
        type: 0,
        parent_id: "300",
        permission_overwrites: [
          { id: "201", type: 0, allow: "0", deny: "2048" }, // captured role → kept
          { id: guildId, type: 0, allow: "0", deny: "1024" }, // @everyone → kept as EVERYONE_REF
          { id: "203", type: 0, allow: "0", deny: "0" }, // skipped role → dropped
          { id: "500", type: 1, allow: "1024", deny: "0" }, // member → dropped
        ],
      },
    ];
    const result = runCapture({
      guildId,
      guild,
      roles,
      channels: channelsWithOverwrites,
      sourceManifest,
    });

    const rules = result.channels.channels?.find((c) => c.key === "rules");
    expect(rules?.overwrites).toEqual([
      { ref: "admin", allow: "0", deny: "2048" },
      { ref: "@everyone", allow: "0", deny: "1024" },
    ]);
    expect(result.everyoneOverwrites).toBe(1);
    expect(result.droppedMemberOverwrites).toBe(1);
    expect(result.droppedRoleOverwrites).toBe(1);
  });

  it("generates unique keys for colliding slugs", () => {
    const duplicateNames = [
      { id: "601", name: "Lounge", type: 0, permission_overwrites: [] },
      { id: "602", name: "Lounge", type: 0, permission_overwrites: [] },
    ];
    const result = runCapture({ guildId, guild, roles, channels: duplicateNames, sourceManifest });
    const keys = (result.channels.channels ?? []).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("skips excluded channels by name (case-insensitive)", () => {
    const withStats = [
      { id: "300", name: "INFORMATION", type: 4, permission_overwrites: [] },
      { id: "700", name: "SERVER STATS", type: 2, permission_overwrites: [] },
    ];
    const result = runCapture({
      guildId,
      guild,
      roles,
      channels: withStats,
      sourceManifest,
      excludeChannelNames: new Set(["server stats"]),
    });
    expect(result.skippedChannels).toContain("SERVER STATS (excluded by name)");
    expect(result.channels.channels?.length).toBe(0);
  });

  it("excludes the whole subtree of an excluded category", () => {
    const withCategory = [
      { id: "c0", name: "📊 SERVER STATS 📊", type: 4, permission_overwrites: [] },
      { id: "v1", name: "All Members: 14", type: 2, parent_id: "c0", permission_overwrites: [] },
      { id: "v2", name: "Bots: 9", type: 2, parent_id: "c0", permission_overwrites: [] },
      { id: "c1", name: "INFORMATION", type: 4, permission_overwrites: [] },
    ];
    const result = runCapture({
      guildId,
      guild,
      roles,
      channels: withCategory,
      sourceManifest,
      excludeChannelNames: new Set(["📊 server stats 📊"]),
    });
    expect(result.skippedChannels).toContain("📊 SERVER STATS 📊 (excluded by name)");
    expect(result.skippedChannels).toContain("All Members: 14 (inside excluded category)");
    expect(result.skippedChannels).toContain("Bots: 9 (inside excluded category)");
    // The unrelated category is still captured.
    expect(result.channels.categories?.map((c) => c.key)).toEqual(["information"]);
  });

  it("round-trips realistic server data back through the config schema", () => {
    // Mirrors the real server: emoji-prefixed names, voice + forum channels,
    // managed bots, member overwrites — all must survive capture → loadConfig.
    const realisticGuild: ApiGuild = {
      id: guildId,
      name: "Grub NSFW",
      features: ["COMMUNITY"],
      verification_level: 2,
      explicit_content_filter: 2,
      default_message_notifications: 1,
      preferred_locale: "en-US",
      rules_channel_id: "r1",
      public_updates_channel_id: "r2",
    };
    const realisticRoles: ApiRole[] = [
      { id: guildId, name: "@everyone", permissions: "104324673" },
      { id: "9", name: "ProBot", permissions: "0", managed: true },
      { id: "10", name: "👑 Admin", permissions: "8", color: 16711680, hoist: true },
      { id: "11", name: "MALE", permissions: "0" },
      { id: "12", name: "FEMALE", permissions: "0" },
      { id: "13", name: "arabic-race", permissions: "0" },
    ];
    const realisticChannels: ApiChannel[] = [
      { id: "c1", name: "📋・INFORMATION", type: 4, permission_overwrites: [] },
      {
        id: "r1",
        name: "rules",
        type: 0,
        parent_id: "c1",
        permission_overwrites: [],
        topic: "read me",
      },
      { id: "r2", name: "announcements", type: 0, parent_id: "c1", permission_overwrites: [] },
      {
        id: "c2",
        name: "🎧・VOICE",
        type: 4,
        permission_overwrites: [
          { id: "11", type: 0, allow: "0", deny: "1024" }, // MALE → kept
          { id: "777", type: 1, allow: "1024", deny: "0" }, // member → dropped
        ],
      },
      { id: "v1", name: "Lounge", type: 2, parent_id: "c2", permission_overwrites: [] },
      {
        id: "f1",
        name: "show-off",
        type: 15,
        permission_overwrites: [],
        available_tags: [
          { id: "t1", name: "Amateur", emoji_name: "🔥" },
          { id: "t2", name: "Pro", emoji_id: "123", emoji_name: "cool" },
        ],
      },
    ];

    const captured = runCapture({
      guildId,
      guild: realisticGuild,
      roles: realisticRoles,
      channels: realisticChannels,
      sourceManifest: manifestWith({
        "roles.arabic-race": binding("role", "arabic-race", "13"),
        "channels.rules": binding("channel", "rules", "r1"),
      }),
    });

    expect(captured.skippedRoles).toContain("ProBot (managed by another bot)");
    expect(captured.droppedMemberOverwrites).toBe(1);

    // The captured fragments are valid authored config: loadConfig re-parses
    // them without errors and the semantic pass finds no issues.
    const loaded = loadConfig({
      guild: captured.guild,
      roles: captured.roles,
      channels: captured.channels,
    });
    expect(loaded.semantic.errors).toEqual([]);
    expect(loaded.guildConfig.guild?.community).toEqual({
      rulesChannel: "rules",
      publicUpdatesChannel: "announcements",
    });

    // Forum tags survive; parent refs point at captured category keys.
    const forum = captured.channels.channels?.find((c) => c.key === "show-off");
    expect(forum?.availableTags).toHaveLength(2);
    const voiceCat = captured.channels.categories?.find((c) => c.name === "🎧・VOICE");
    const voice = captured.channels.channels?.find((c) => c.name === "Lounge");
    expect(voice?.parent).toBe(voiceCat?.key);
  });
});

// --- Onboarding capture ---

const genderRoles: ApiRole[] = [
  { id: "801", name: "───────ஓ๑GENDER๑ஓ ───────", permissions: "0" }, // separator
  { id: "802", name: "HOMBRE", permissions: "0" },
  { id: "803", name: "MUJER", permissions: "0" },
  { id: "804", name: "BINARY", permissions: "0" }, // no dedicated role in config
];

const onboarding: ApiOnboarding = {
  guild_id: guildId,
  enabled: true,
  mode: 1, // ONBOARDING_ADVANCED
  default_channel_ids: ["400", "401", "402", "403", "404", "405", "406"],
  prompts: [
    {
      id: "p1",
      title: "「⋆｡˚❀▪WHAT GENDER DO YOU IDENTIFY WITH?▪❀˚｡⋆」",
      type: 0, // MULTIPLE_CHOICE
      single_select: true,
      required: true,
      in_onboarding: true,
      options: [
        {
          id: "o1",
          title: "MAN",
          description: "",
          emoji: { id: null, name: "♂️", animated: false },
          role_ids: ["801", "802"], // separator + specific
          channel_ids: [],
        },
        {
          id: "o2",
          title: "WOMAN",
          description: "",
          emoji: { id: null, name: "♀️", animated: false },
          role_ids: ["801", "803"],
          channel_ids: [],
        },
        {
          id: "o3",
          title: "BINARY",
          description: "",
          emoji: { id: null, name: "👫", animated: false },
          role_ids: ["801"], // only the separator
          channel_ids: [],
        },
      ],
    },
    {
      id: "p2",
      title: "WHERE ARE YOU FROM?",
      type: 1, // DROPDOWN
      single_select: false,
      required: false,
      in_onboarding: false,
      options: [
        {
          id: "o4",
          title: "ARGENTINA",
          description: "",
          emoji: { id: null, name: "🇦🇷", animated: false },
          role_ids: ["805", "806"],
          channel_ids: ["400"],
        },
        {
          id: "o5",
          title: "MEXICO",
          description: "",
          emoji: { id: null, name: "🇲🇽", animated: false },
          role_ids: ["805", "807"],
          channel_ids: [],
        },
      ],
    },
  ],
};

function runWithOnboarding() {
  return runCapture({
    guildId,
    guild,
    roles: [
      ...roles,
      ...genderRoles,
      { id: "805", name: "COUNTRY", permissions: "0" }, // separator
      { id: "806", name: "ARGENTINA", permissions: "0" },
      { id: "807", name: "MEXICO", permissions: "0" },
    ],
    channels: [
      ...channels,
      { id: "402", name: "welcome", type: 0, permission_overwrites: [] },
      { id: "403", name: "announcements", type: 0, permission_overwrites: [] },
      { id: "404", name: "events", type: 0, permission_overwrites: [] },
      { id: "405", name: "streams", type: 0, permission_overwrites: [] },
      { id: "406", name: "support", type: 0, permission_overwrites: [] },
      { id: "407", name: "community", type: 0, permission_overwrites: [] },
    ],
    onboarding,
    sourceManifest,
  });
}

describe("runCapture — onboarding", () => {
  it("derives prompt keys from the separator role name (GENDER → gender)", () => {
    const result = runWithOnboarding();
    const keys = result.onboarding?.prompts.map((p) => p.key);
    expect(keys).toContain("gender");
  });

  it("maps option roles (separator stripped) to role keys and keeps the emoji", () => {
    const result = runWithOnboarding();
    const gender = result.onboarding?.prompts.find((p) => p.key === "gender");
    expect(gender?.title).toBe("「⋆｡˚❀▪WHAT GENDER DO YOU IDENTIFY WITH?▪❀˚｡⋆」");
    expect(gender?.type).toBe("MULTIPLE_CHOICE");
    expect(gender?.singleSelect).toBe(true);
    expect(gender?.required).toBe(true);
    expect(gender?.inOnboarding).toBe(true);
    // The separator role (801, name "GENDER") becomes the prompt's separatorRole ref.
    expect(gender?.separatorRole).toBe("gender");
    // Option MAN → role 802 (HOMBRE) → key "hombre", roles: ["hombre"].
    expect(gender?.options[0]).toMatchObject({
      key: "hombre",
      title: "MAN",
      emoji: "♂️",
      roles: ["hombre"],
    });
    // Option BINARY → no specific role → key from the title, no roles field.
    expect(gender?.options[2]).toMatchObject({ key: "binary", title: "BINARY", emoji: "👫" });
    expect(gender?.options[2]?.roles).toBeUndefined();
  });

  it("captures DROPDOWN prompts, option channel refs and default channels", () => {
    const result = runWithOnboarding();
    const country = result.onboarding?.prompts.find((p) => p.key === "country");
    expect(country?.type).toBe("DROPDOWN");
    // singleSelect is only emitted when true.
    expect(country?.singleSelect).toBeUndefined();
    expect(country?.separatorRole).toBe("country");
    expect(country?.options[0]).toMatchObject({
      key: "argentina",
      title: "ARGENTINA",
      roles: ["argentina"],
      channels: ["rules"], // channel 400 → borrowed key "rules"
    });
    expect(country?.options[1]).toMatchObject({
      key: "mexico",
      title: "MEXICO",
      roles: ["mexico"],
    });
    expect(result.onboarding?.base).toMatchObject({
      enabled: true,
      mode: "ONBOARDING_ADVANCED",
      defaultChannels: [
        "rules",
        "moderator-only",
        "welcome",
        "announcements",
        "events",
        "streams",
        "support",
      ],
    });
  });

  it("round-trips the captured onboarding back through the config schema", () => {
    const result = runWithOnboarding();
    const onboarding = result.onboarding;
    expect(onboarding).toBeDefined();

    const loaded = loadConfig({
      onboarding: {
        ...(onboarding?.base ?? { enabled: false, mode: "ONBOARDING_DEFAULT" }),
        prompts: onboarding?.prompts ?? [],
      },
    });
    expect(loaded.semantic.errors).toEqual([]);
  });
});
