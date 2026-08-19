import { describe, expect, it } from "vitest";
import { FakeDiscord } from "../../src/adapters/fake-adapter.js";
import { canonicalizeDesired, type ResolvedOnboarding } from "../../src/domain/canonicalize.js";
import { verify } from "../../src/engine/verify.js";
import type { ApiOnboarding } from "../../src/port/discord-types.js";

function desired(): ResolvedOnboarding {
  return {
    enabled: true,
    mode: "ONBOARDING_DEFAULT",
    defaultChannelIds: ["100", "101"],
    prompts: [
      {
        key: "p",
        title: "Path",
        type: "MULTIPLE_CHOICE",
        singleSelect: true,
        required: true,
        inOnboarding: true,
        options: [{ key: "o", title: "Option", roleIds: [], channelIds: ["100"] }],
      },
    ],
  };
}

const guild = { id: "123", name: "Test", features: [] };

function seed(onboarding?: ApiOnboarding): FakeDiscord {
  return new FakeDiscord({
    guild,
    channels: [
      { id: "100", name: "a", type: 0 },
      { id: "101", name: "b", type: 0 },
    ],
    roles: [{ id: "123", name: "@everyone", permissions: "2048" }],
    ...(onboarding ? { onboarding } : {}),
  });
}

describe("verify", () => {
  it("classifies converged when re-discovery matches desired", async () => {
    const fake = seed();
    await fake.updateOnboarding(
      "123",
      {
        prompts: [
          {
            id: "9",
            title: "Path",
            type: 0,
            single_select: true,
            required: true,
            in_onboarding: true,
            options: [{ id: "8", title: "Option", role_ids: [], channel_ids: ["100"] }],
          },
        ],
        default_channel_ids: ["100", "101"],
        enabled: true,
        mode: 0,
      },
      "seed",
    );
    const result = await verify(fake, "123", canonicalizeDesired(desired()));
    expect(result.className).toBe("converged");
  });

  it("classifies residual-drift when the live state diverges", async () => {
    const fake = seed();
    await fake.updateOnboarding(
      "123",
      {
        prompts: [],
        default_channel_ids: ["100"],
        enabled: true,
        mode: 0,
      },
      "seed",
    );
    const result = await verify(fake, "123", canonicalizeDesired(desired()));
    expect(result.className).toBe("residual-drift");
    expect(result.reason).toContain("default_channel_ids");
  });

  it("classifies verify-failed when the read throws", async () => {
    const fake = seed();
    // Guild mismatch → FakeApiError 10004 on every read.
    const result = await verify(fake, "999", canonicalizeDesired(desired()));
    expect(result.className).toBe("verify-failed");
  });
});
