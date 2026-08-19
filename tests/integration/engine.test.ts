import { describe, expect, it } from "vitest";

import { FakeDiscord } from "../../src/adapters/fake-adapter.js";
import {
  ConfigError,
  MissingBindingsError,
  PreflightError,
  runEngine,
} from "../../src/engine/engine.js";
import type { ManifestData } from "../../src/identity/types.js";

/**
 * Integration tests (testing.md §2): the full engine pipeline against the fake
 * Discord API. Production code never imports the fake; the fake is the HTTP
 * boundary double.
 */

function manifestWith(bindings: ManifestData["bindings"] = {}, guildId = "123"): ManifestData {
  return {
    meta: { schemaVersion: 1, guildId, createdAt: "x", deletionPolicy: "never" },
    bindings,
  };
}

function binding(kind: "role" | "channel", key: string, discordId: string) {
  return {
    key,
    aliases: [],
    kind,
    discordId,
    createdAt: "x",
  };
}

const validConfig = {
  onboarding: {
    enabled: true,
    mode: "ONBOARDING_DEFAULT",
    defaultChannels: [
      "general",
      "gaming",
      "announcements",
      "events",
      "streams",
      "support",
      "community",
    ],
    prompts: [
      {
        key: "choose-your-path",
        title: "Choose your path",
        type: "MULTIPLE_CHOICE",
        singleSelect: true,
        required: true,
        inOnboarding: true,
        options: [
          {
            key: "chat",
            title: "Chat",
            roles: ["male"],
            channels: ["gaming"],
          },
        ],
      },
    ],
  },
};

const manifest = manifestWith({
  "channels.general": binding("channel", "general", "100"),
  "channels.gaming": binding("channel", "gaming", "101"),
  "channels.announcements": binding("channel", "announcements", "102"),
  "channels.events": binding("channel", "events", "103"),
  "channels.streams": binding("channel", "streams", "104"),
  "channels.support": binding("channel", "support", "105"),
  "channels.community": binding("channel", "community", "106"),
  "roles.male": binding("role", "male", "201"),
});

const guild = { id: "123", name: "Test Guild", features: [] };

/** 7 channels that all allow SEND_MESSAGES to @everyone (base perms). */
function seedChannels(): Array<{ id: string; name: string; type: number }> {
  const names = ["general", "gaming", "announcements", "events", "streams", "support", "community"];
  return names.map((name, index) => ({ id: String(100 + index), name, type: 0 }));
}

/** @everyone role: id === guildId, SEND_MESSAGES (2048) + VIEW_CHANNEL (1024)
 *  base perms (Discord's @everyone always has both). */
const everyoneRole = { id: "123", name: "@everyone", permissions: "3072" };

function seedFake(): FakeDiscord {
  return new FakeDiscord({
    guild,
    channels: seedChannels(),
    roles: [everyoneRole],
  });
}

describe("runEngine — dry-run (phases 1–7)", () => {
  it("produces an UPDATE plan with resolved snowflakes and executes nothing", async () => {
    const fake = seedFake();
    const result = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: true,
    });

    expect(result.plan.op).toBe("UPDATE");
    expect(result.preflight.ok).toBe(true);
    expect(result.plan.payload?.default_channel_ids).toEqual([
      "100",
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
    ]);
    const option = result.plan.payload?.prompts[0]?.options[0];
    expect(option?.role_ids).toEqual(["201"]);
    expect(option?.channel_ids).toEqual(["101"]);
    // Dry-run must not mutate.
    expect(fake.updates).toHaveLength(0);
    expect(fake.onboarding.enabled).toBe(false);
  });

  it("reports NOOP when the live state already converges", async () => {
    const fake = seedFake();
    // First apply, then re-run dry → NOOP.
    await runEngine(validConfig, { port: fake, manifest, guildId: "123", dryRun: false });
    const second = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: true,
    });
    expect(second.plan.op).toBe("NOOP");
    expect(second.verify).toBeUndefined();
  });

  it("converges idempotently across apply runs (exit 0 on second sync)", async () => {
    const fake = seedFake();
    const first = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: false,
    });
    expect(first.plan.op).toBe("UPDATE");
    expect(first.verify?.className).toBe("converged");

    const second = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: false,
    });
    expect(second.plan.op).toBe("NOOP");
  });
});

describe("runEngine — errors", () => {
  it("aborts on invalid config before any network call", async () => {
    const fake = seedFake();
    const bad = {
      onboarding: {
        enabled: true,
        defaultChannels: ["general", "gaming"], // <7 while enabled
        prompts: [],
      },
    };
    await expect(
      runEngine(bad, { port: fake, manifest, guildId: "123", dryRun: true }),
    ).rejects.toThrow(ConfigError);
    expect(fake.reads.getOnboarding).toBe(0);
    expect(fake.reads.listChannels).toBe(0);
  });

  it("reports every unbound logical key with the adopt hint", async () => {
    const fake = seedFake();
    const minimal = manifestWith({
      "channels.general": binding("channel", "general", "100"),
      "channels.gaming": binding("channel", "gaming", "101"),
      "channels.announcements": binding("channel", "announcements", "102"),
      "channels.events": binding("channel", "events", "103"),
      "channels.streams": binding("channel", "streams", "104"),
      "channels.support": binding("channel", "support", "105"),
      "channels.community": binding("channel", "community", "106"),
      // roles.male intentionally missing
    });
    const error = await runEngine(validConfig, {
      port: fake,
      manifest: minimal,
      guildId: "123",
      dryRun: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MissingBindingsError);
    const missing = error as MissingBindingsError;
    expect(missing.missing).toContain("roles.male");
    expect(missing.message).toContain("chrysalis adopt");
  });

  it("fails pre-flight when fewer than 5 default channels allow SEND_MESSAGES", async () => {
    // @everyone has no SEND_MESSAGES; channels have no overwrite → effective 0.
    const fake = new FakeDiscord({
      guild,
      channels: seedChannels(),
      roles: [{ id: "123", name: "@everyone", permissions: "0" }],
    });
    const error = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreflightError);
    const preflightError = error as PreflightError;
    expect(preflightError.preflight.ok).toBe(false);
    expect(preflightError.message).toContain("SEND_MESSAGES");
    // Pre-flight failure must not execute.
    expect(fake.updates).toHaveLength(0);
  });
});

describe("runEngine — apply (phases 1–10)", () => {
  it("sets X-Audit-Log reason and verifies convergence", async () => {
    const fake = seedFake();
    const result = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: false,
    });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updateReasons[0]).toContain("Chrysalis: onboarding sync");
    expect(result.verify?.className).toBe("converged");
    expect(fake.onboarding.enabled).toBe(true);
  });

  it("reuses prompt ids on re-apply (no id churn)", async () => {
    const fake = seedFake();
    await runEngine(validConfig, { port: fake, manifest, guildId: "123", dryRun: false });
    const firstId = fake.onboarding.prompts[0]?.id;

    // Introduce drift (a new default channel) then re-apply.
    fake.onboarding.default_channel_ids = ["100"];
    const second = await runEngine(validConfig, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: false,
    });
    expect(second.plan.op).toBe("UPDATE");
    expect(fake.onboarding.prompts[0]?.id).toBe(firstId);
  });

  it("converges for post-join prompts without inOnboarding (payload must send false)", async () => {
    // Regression: buildPayload used to emit `in_onboarding: undefined`, which
    // JSON.stringify drops; Discord defaults a missing in_onboarding to true,
    // flooding the flow with post-join prompts (TOO_MANY_ONBOARDING_PROMPTS).
    const config = {
      onboarding: {
        enabled: true,
        mode: "ONBOARDING_DEFAULT",
        defaultChannels: validConfig.onboarding.defaultChannels,
        prompts: [
          {
            key: "post-join",
            title: "Post-join DM preferences",
            type: "DROPDOWN",
            singleSelect: true,
            // inOnboarding intentionally absent — post-join prompt.
            options: [{ key: "open", title: "OPEN", roles: ["male"], channels: [] }],
          },
        ],
      },
    };
    const fake = seedFake();

    const first = await runEngine(config, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: false,
    });
    // Payload sends in_onboarding: false explicitly (fix G1).
    // The live state must carry it as false (not defaulted true by Discord).
    expect(first.plan.op).toBe("UPDATE");
    expect(fake.onboarding.prompts[0]?.in_onboarding).toBe(false);
    // Convergence verified: second dry-run produces NOOP.
    const second = await runEngine(config, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: true,
    });
    expect(second.plan.op).toBe("NOOP");
  });
});
});

describe("runEngine — prompts only (manageDefaultChannels: false)", () => {
  const promptsOnlyConfig = {
    onboarding: {
      enabled: true,
      mode: "ONBOARDING_DEFAULT",
      manageDefaultChannels: false,
      prompts: validConfig.onboarding.prompts,
    },
  };

  // Only option-level bindings required (option.channels → gaming, option.roles → male).
  // No default-channel bindings (general/announcements/etc.) are needed.
  const rolesOnlyManifest = manifestWith({
    "roles.male": binding("role", "male", "201"),
    "channels.gaming": binding("channel", "gaming", "101"),
  });

  it("carries the current default channels over and does not require channel bindings", async () => {
    const fake = seedFake();
    // Simulate the server's current "everything is default" state.
    fake.onboarding.default_channel_ids = ["100", "101", "102"];

    const result = await runEngine(promptsOnlyConfig, {
      port: fake,
      manifest: rolesOnlyManifest,
      guildId: "123",
      dryRun: true,
    });

    expect(result.plan.op).toBe("UPDATE");
    // Defaults are untouched: carried over from the live state, not resolved.
    expect(result.plan.payload?.default_channel_ids).toEqual(["100", "101", "102"]);
    expect(fake.updates).toHaveLength(0);
  });

  it("applies prompts and leaves default channels unchanged, converging on re-run", async () => {
    const fake = seedFake();
    fake.onboarding.default_channel_ids = ["100", "101", "102"];

    const first = await runEngine(promptsOnlyConfig, {
      port: fake,
      manifest: rolesOnlyManifest,
      guildId: "123",
      dryRun: false,
    });
    expect(first.plan.op).toBe("UPDATE");
    expect(first.verify?.className).toBe("converged");
    // The live defaults were not modified by the apply.
    expect(fake.onboarding.default_channel_ids).toEqual(["100", "101", "102"]);
    expect(fake.onboarding.enabled).toBe(true);
    expect(fake.onboarding.prompts).toHaveLength(1);

    const second = await runEngine(promptsOnlyConfig, {
      port: fake,
      manifest: rolesOnlyManifest,
      guildId: "123",
      dryRun: true,
    });
    expect(second.plan.op).toBe("NOOP");
  });

  it("converges when options carry emojis (real API nested-emoji round-trip)", async () => {
    const fake = seedFake();
    fake.onboarding.default_channel_ids = ["100"];
    const config = {
      onboarding: {
        enabled: true,
        mode: "ONBOARDING_DEFAULT",
        manageDefaultChannels: false,
        prompts: [
          {
            key: "country",
            title: "What country are you from?",
            type: "DROPDOWN",
            singleSelect: true,
            required: true,
            inOnboarding: true,
            options: [
              { key: "canada", title: "CANADA", emoji: "🇨🇦", roleId: "1507545623992209001" },
            ],
          },
        ],
      },
    };
    const manifest = manifestWith({
      "roles.canada": binding("role", "canada", "1507545623992209001"),
    });

    const first = await runEngine(config, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: false,
    });
    expect(first.plan.op).toBe("UPDATE");
    expect(first.verify?.className).toBe("converged");
    // The stored state must carry the emoji (nested, like the real API).
    expect(fake.onboarding.prompts[0]?.options[0]?.emoji).toEqual({
      id: null,
      name: "🇨🇦",
      animated: false,
    });

    const second = await runEngine(config, {
      port: fake,
      manifest,
      guildId: "123",
      dryRun: true,
    });
    expect(second.plan.op).toBe("NOOP");
  });
});
