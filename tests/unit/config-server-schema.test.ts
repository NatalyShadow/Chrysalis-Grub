import { describe, expect, it } from "vitest";

import { parseGuildConfig } from "../../src/config/schema/onboarding.js";

/** Minimal valid clone spec (guild + roles + channels). */
function validClone() {
  return {
    guild: {
      name: "Grub NSFW",
      verificationLevel: 2,
      explicitContentFilter: 2,
      defaultMessageNotifications: 1,
      preferredLocale: "en-US",
      community: { rulesChannel: "rules", publicUpdatesChannel: "mod-only" },
    },
    roles: {
      roles: [
        { key: "admin", name: "👑 Admin", color: 16711680, hoist: true, permissions: "8" },
        { key: "verified", name: "VERIFY", permissions: "0" },
      ],
      ordering: ["admin", "verified"],
    },
    channels: {
      categories: [{ key: "cat-info", name: "INFORMATION", type: 4 }],
      channels: [
        { key: "rules", name: "rules", type: 0, parent: "cat-info", topic: "read me" },
        {
          key: "mod-only",
          name: "moderator-only",
          type: 0,
          parent: "cat-info",
          overwrites: [{ ref: "admin", deny: "2048" }],
        },
      ],
    },
  };
}

describe("server kinds schema (guild / roles / channels)", () => {
  it("accepts a full valid clone spec", () => {
    const parsed = parseGuildConfig(validClone());
    expect(parsed.guild?.name).toBe("Grub NSFW");
    expect(parsed.roles?.ordering).toEqual(["admin", "verified"]);
    expect(parsed.channels?.categories?.[0]?.key).toBe("cat-info");
    expect(parsed.channels?.channels?.[1]?.overwrites?.[0]?.ref).toBe("admin");
  });

  it("rejects community with only one channel", () => {
    const data = validClone();
    (data.guild as { community: Record<string, unknown> }).community = {
      rulesChannel: "rules",
    };
    expect(() => parseGuildConfig(data)).toThrow(/requires both/);
  });

  it("rejects duplicate role keys", () => {
    const data = validClone();
    (data.roles as { roles: unknown[] }).roles = [
      { key: "admin", name: "Admin" },
      { key: "admin", name: "Admin 2" },
    ];
    expect(() => parseGuildConfig(data)).toThrow(/duplicate role keys/);
  });

  it("rejects an ordering that is not a permutation of the role keys", () => {
    const data = validClone();
    (data.roles as { ordering: string[] }).ordering = ["admin"];
    expect(() => parseGuildConfig(data)).toThrow(/must include every role key/);
  });

  it("rejects a child whose parent is not a declared category", () => {
    const data = validClone();
    (data.channels as { channels: unknown[] }).channels = [
      { key: "rules", name: "rules", type: 0, parent: "nope" },
    ];
    expect(() => parseGuildConfig(data)).toThrow(/not a declared category/);
  });

  it("rejects a category that declares a parent", () => {
    const data = validClone();
    (data.channels as { categories: unknown[] }).categories = [
      { key: "cat-info", name: "INFORMATION", type: 4, parent: "cat-other" },
    ];
    expect(() => parseGuildConfig(data)).toThrow(/categories cannot have a parent/);
  });

  it("rejects duplicate keys in channel ordering", () => {
    const data = validClone();
    (data.channels as typeof data.channels & { ordering?: string[] }).ordering = [
      "cat-info",
      "cat-info",
    ];
    expect(() => parseGuildConfig(data)).toThrow(/duplicate keys in channel ordering/);
  });

  it("rejects channel ordering that omits declared keys", () => {
    const data = validClone();
    (data.channels as typeof data.channels & { ordering?: string[] }).ordering = ["cat-info"];
    expect(() => parseGuildConfig(data)).toThrow(/must include every channel key/);
  });

  it("rejects duplicate channel keys across categories and children", () => {
    const data = validClone();
    (data.channels as { categories: unknown[] }).categories = [
      { key: "rules", name: "INFORMATION", type: 4 },
    ];
    expect(() => parseGuildConfig(data)).toThrow(/duplicate channel keys/);
  });

  it("rejects an invalid overwrite allow bitfield", () => {
    const data = validClone();
    (data.channels as { channels: unknown[] }).channels = [
      { key: "x", name: "x", type: 0, overwrites: [{ ref: "admin", allow: "abc" }] },
    ];
    expect(() => parseGuildConfig(data)).toThrow(/base-10 bitfield/);
  });

  it("accepts a fragment without the new kinds (backwards compatible)", () => {
    const parsed = parseGuildConfig({
      onboarding: {
        enabled: true,
        mode: "ONBOARDING_DEFAULT",
        defaultChannels: ["general"],
        prompts: [
          {
            key: "path",
            title: "Choose your path",
            type: "MULTIPLE_CHOICE",
            options: [{ key: "chat", title: "Chat" }],
          },
        ],
      },
    });
    expect(parsed.guild).toBeUndefined();
    expect(parsed.roles).toBeUndefined();
    expect(parsed.channels).toBeUndefined();
  });
});
