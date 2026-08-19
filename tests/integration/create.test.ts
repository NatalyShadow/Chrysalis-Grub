import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDiscord } from "../../src/adapters/fake-adapter.js";
import { PendingCreateRecoveryError, runReconcile } from "../../src/engine/create.js";
import { ManifestStore } from "../../src/identity/manifest.js";
import type { ApiGuild } from "../../src/port/discord-types.js";
import { requireDefined } from "../helpers/require-defined.js";

/** @everyone role: id === guildId, SEND_MESSAGES (2048) + VIEW_CHANNEL (1024)
 *  base perms so onboarding preflight passes (Discord's @everyone always has
 *  both by default). */
const everyoneRole = { id: "123", name: "@everyone", permissions: "3072" };

/** Clone spec for a target guild. explicitContentFilter 2 matches Discord's
 *  undocumented COMMUNITY prerequisite (enable-community converges). */
const cloneConfig = {
  guild: {
    name: "Grub NSFW",
    verificationLevel: 1,
    explicitContentFilter: 2,
    defaultMessageNotifications: 1,
    preferredLocale: "en-US",
    community: { rulesChannel: "rules", publicUpdatesChannel: "announcements" },
  },
  roles: {
    roles: [
      { key: "admin", name: "👑 Admin", color: 16711680, hoist: true, permissions: "8" },
      { key: "verified", name: "VERIFY", permissions: "0" },
      { key: "male", name: "MALE", permissions: "0" },
    ],
    ordering: ["admin", "verified", "male"],
  },
  channels: {
    categories: [{ key: "cat-info", name: "INFORMATION", type: 4 }],
    channels: [
      {
        key: "rules",
        name: "rules",
        type: 0,
        parent: "cat-info",
        topic: "read the rules",
        overwrites: [
          { ref: "admin", deny: "2048" },
          { ref: "@everyone", deny: "1024" },
        ],
      },
      { key: "announcements", name: "announcements", type: 0, parent: "cat-info" },
      { key: "general", name: "general", type: 0 },
      { key: "gaming", name: "gaming", type: 0 },
      { key: "events", name: "events", type: 0 },
      { key: "streams", name: "streams", type: 0 },
      { key: "support", name: "support", type: 0 },
      { key: "community", name: "community", type: 0 },
    ],
  },
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
        options: [{ key: "chat", title: "Chat", roles: ["male"], channels: ["gaming"] }],
      },
    ],
  },
};

const roleOnlyConfig = {
  roles: {
    roles: [{ key: "admin", name: "Admin", permissions: "8" }],
    ordering: ["admin"],
  },
};

const channelOnlyConfig = {
  channels: {
    channels: [{ key: "general", name: "general", type: 0 }],
  },
};

const orderedChannelsConfig = {
  channels: {
    categories: [
      { key: "cat-a", name: "A", type: 4 },
      { key: "cat-b", name: "B", type: 4 },
    ],
    channels: [
      { key: "a-one", name: "A one", type: 0, parent: "cat-a" },
      { key: "a-two", name: "A two", type: 0, parent: "cat-a" },
      { key: "b-one", name: "B one", type: 0, parent: "cat-b" },
    ],
    ordering: ["cat-b", "b-one", "cat-a", "a-two", "a-one"],
  },
};

/** Announcement (type 5) channels require a COMMUNITY guild; the plan must
 *  create them AFTER the enable-community op. */
const announcementConfig = {
  guild: {
    name: "Grub NSFW",
    community: { rulesChannel: "rules", publicUpdatesChannel: "announcements" },
  },
  channels: {
    categories: [{ key: "cat-info", name: "INFORMATION", type: 4 }],
    channels: [
      { key: "rules", name: "rules", type: 0, parent: "cat-info" },
      { key: "announcements", name: "announcements", type: 0, parent: "cat-info" },
      { key: "news", name: "news", type: 5, parent: "cat-info" },
    ],
  },
};

class FailOnceAfterPendingManifestStore extends ManifestStore {
  private saveCount = 0;

  override async save(data: Parameters<ManifestStore["save"]>[0]): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === 2) {
      throw new Error("simulated manifest failure after remote create");
    }
    await super.save(data);
  }
}

/** Fresh target guild: default Discord settings, no COMMUNITY yet. */
function freshGuild(): ApiGuild {
  return {
    id: "123",
    name: "Grub NSFW",
    features: [],
    verification_level: 1,
    explicit_content_filter: 2,
    default_message_notifications: 1,
    preferred_locale: "en-US",
    rules_channel_id: null,
    public_updates_channel_id: null,
  };
}

function seedFake(): FakeDiscord {
  return new FakeDiscord({ guild: freshGuild(), roles: [everyoneRole] });
}

describe("runReconcile — clone flow against the fake API", () => {
  let dir: string;
  let manifestStore: ManifestStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-create-"));
    manifestStore = new ManifestStore(join(dir, "manifest.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dry-run on a fresh target plans everything, mutates nothing, and notes onboarding", async () => {
    const fake = seedFake();
    const result = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: true,
    });

    expect(result.applied).toBe(0);
    expect(result.plan.ops.map((op) => op.op)).toEqual([
      "create-role",
      "create-role",
      "create-role",
      "create-channel",
      "create-channel",
      "create-channel",
      "create-channel",
      "create-channel",
      "create-channel",
      "create-channel",
      "create-channel",
      "create-channel",
      "enable-community",
    ]);
    expect(result.onboardingNote).toContain("after the resources are created");
    // No mutation whatsoever.
    expect(fake.createdRoles).toHaveLength(0);
    expect(fake.createdChannels).toHaveLength(0);
    expect(fake.guildPatches).toHaveLength(0);
    expect(fake.channelPatches).toHaveLength(0);
  });

  it("creates roles + channels, binds them, enables COMMUNITY, and converges on the next run", async () => {
    const fake = seedFake();

    const first = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(first.applied).toBeGreaterThan(0);
    expect(fake.createdRoles).toHaveLength(3);
    expect(fake.createdChannels).toHaveLength(9); // 1 category + 8 children
    expect(fake.guildPatches.some((patch) => patch.features?.includes("COMMUNITY"))).toBe(true);
    expect(fake.onboarding.enabled).toBe(true);
    expect(fake.updates).toHaveLength(1);

    // Create-and-bind: the manifest file on disk now holds the new snowflakes.
    const onDisk = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
      bindings: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.bindings)).toHaveLength(12); // 3 roles + 9 channels

    // Overwrites of the rules channel got resolved: the freshly created admin
    // role for the role ref and the target guild id for the @everyone ref.
    const rules = fake.channels.find((channel) => channel.name === "rules");
    expect(rules?.permission_overwrites).toHaveLength(2);
    const adminOverwrite = rules?.permission_overwrites?.find(
      (o) => o.id === fake.createdRoles[0]?.id,
    );
    expect(adminOverwrite?.deny).toBe("2048");
    const everyoneOverwrite = rules?.permission_overwrites?.find((o) => o.id === "123");
    expect(everyoneOverwrite?.deny).toBe("1024");

    // Community channels were linked.
    const rulesId = fake.channels.find((channel) => channel.name === "rules")?.id;
    expect(fake.guild.rules_channel_id).toBe(rulesId);

    // Second run: fully converged, no ops.
    const second = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });
    expect(second.plan.ops).toHaveLength(0);
    expect(second.applied).toBe(0);
    // The role reorder ran once during the first run (post-create, same run)
    // and did not repeat on the converged second run.
    expect(fake.rolePositionPatches).toHaveLength(1);
    expect(fake.channelPositionPatches).toHaveLength(0);
  });

  it("resumes after a partial state: recreates only the missing resource", async () => {
    const fake = seedFake();
    await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    // Simulate a resource vanishing from the live guild (bot removed a channel).
    const general = fake.channels.find((channel) => channel.name === "general");
    expect(general).toBeDefined();
    fake.channels = fake.channels.filter((channel) => channel.id !== general?.id);

    const resumed = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    const recreated = resumed.plan.ops.filter((op) => op.op === "create-channel");
    expect(recreated).toHaveLength(1);
    expect(fake.channels.some((channel) => channel.name === "general")).toBe(true);
  });

  it("patches drift (renamed channel, changed role) and converges", async () => {
    const fake = seedFake();
    await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    // Introduce drift: rename a channel and a role.
    const general = requireDefined(
      fake.channels.find((channel) => channel.name === "general"),
      "general channel",
    );
    general.name = "general-renamed";
    const admin = requireDefined(
      fake.roles.find((role) => role.name === "👑 Admin"),
      "admin role",
    );
    admin.name = "Admin HACKED";

    const drifted = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });
    expect(drifted.plan.ops.map((op) => op.op).sort()).toEqual(["update-channel", "update-role"]);
    expect(fake.channelPatches.some((entry) => entry.patch.name === "general")).toBe(true);
    expect(fake.rolePatches.some((entry) => entry.patch.name === "👑 Admin")).toBe(true);

    const final = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });
    expect(final.plan.ops).toHaveLength(0);
  });

  it("does not emit enable-community when the target already has COMMUNITY", async () => {
    const fake = new FakeDiscord({
      guild: { ...freshGuild(), features: ["COMMUNITY"] },
      roles: [everyoneRole],
    });

    const result = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: true,
    });

    expect(result.plan.ops.map((op) => op.op)).not.toContain("enable-community");
  });

  it("applies custom channel ordering after creating a fresh target", async () => {
    const fake = seedFake();
    const first = await runReconcile(orderedChannelsConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(first.plan.deferredChannelOrdering).toBe(true);
    expect(fake.channelPositionPatches).toHaveLength(1);
    const positionPatch = fake.channelPositionPatches[0];
    expect(positionPatch?.map((entry) => entry.id)).toEqual(["1001", "1000", "1003", "1002"]);

    const second = await runReconcile(orderedChannelsConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(second.plan.ops).toHaveLength(0);
    expect(second.plan.deferredChannelOrdering).toBe(false);
    expect(fake.channelPositionPatches).toHaveLength(1);
  });

  it("creates announcement channels only after enable-community", async () => {
    const fake = seedFake();
    const result = await runReconcile(announcementConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: true,
    });

    const ops = result.plan.ops;
    const enableIdx = ops.findIndex((op) => op.op === "enable-community");
    const announcementIdx = ops.findIndex((op) => op.op === "create-channel" && op.key === "news");
    expect(enableIdx).toBeGreaterThan(-1);
    expect(announcementIdx).toBeGreaterThan(enableIdx);
    // The announcement create must carry type 5.
    const announcementOp = ops[announcementIdx];
    expect(announcementOp).toMatchObject({
      op: "create-channel",
      key: "news",
      payload: { type: 5 },
    });
  });

  it("enables COMMUNITY with Discord's undocumented prereqs and preserves existing features", async () => {
    // The live guild already has some features (e.g. ANIMATED_ICON) and a low
    // explicit content filter; Discord rejects the COMMUNITY PATCH unless
    // explicit_content_filter is raised to 2 first.
    const fake = new FakeDiscord({
      guild: {
        ...freshGuild(),
        features: ["ANIMATED_ICON"],
        explicit_content_filter: 0,
      },
      roles: [everyoneRole],
    });

    const first = await runReconcile(cloneConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(first.applied).toBeGreaterThan(0);
    // Prereq PATCH: explicit_content_filter raised to 2, verification kept >= 1.
    expect(
      fake.guildPatches.some(
        (patch) => patch.explicit_content_filter === 2 && (patch.verification_level ?? 1) >= 1,
      ),
    ).toBe(true);
    // The combined PATCH keeps existing features and adds COMMUNITY.
    const combined = fake.guildPatches.find(
      (patch) =>
        patch.features?.includes("COMMUNITY") &&
        patch.rules_channel_id !== undefined &&
        patch.public_updates_channel_id !== undefined,
    );
    expect(combined?.features).toEqual(["ANIMATED_ICON", "COMMUNITY"]);
    expect(fake.guild.features).toContain("COMMUNITY");
    expect(fake.guild.features).toContain("ANIMATED_ICON");
  });

  it("applies custom role ordering after creating a fresh target in the same run", async () => {
    const fake = seedFake();
    const config = {
      roles: {
        roles: [
          { key: "admin", name: "Admin", permissions: "8" },
          { key: "mod", name: "Mod", permissions: "0" },
          { key: "member", name: "Member", permissions: "0" },
        ],
        ordering: ["admin", "mod", "member"],
      },
    };

    const first = await runReconcile(config, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    // Roles were created this run → the position settle is deferred, then
    // executed post-create in the same run.
    expect(first.plan.deferredRoleOrdering).toBe(true);
    expect(fake.createdRoles).toHaveLength(3);
    expect(fake.rolePositionPatches).toHaveLength(1);
    const positionPatch = fake.rolePositionPatches[0];
    expect(positionPatch?.map((entry) => entry.id)).toEqual([
      fake.createdRoles[0]?.id,
      fake.createdRoles[1]?.id,
      fake.createdRoles[2]?.id,
    ]);

    const second = await runReconcile(config, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(second.plan.ops).toHaveLength(0);
    expect(second.plan.deferredRoleOrdering).toBe(false);
    expect(fake.rolePositionPatches).toHaveLength(1);
  });

  it("recovers a role created before the response was lost without duplicating it", async () => {
    const fake = new FakeDiscord({
      guild: freshGuild(),
      roles: [everyoneRole],
      config: { failAfterCreateRole: true },
    });

    await expect(
      runReconcile(roleOnlyConfig, {
        port: fake,
        manifestStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toThrow(/Internal Server Error after role creation/);

    expect(fake.createdRoles).toHaveLength(1);
    expect((await manifestStore.load())?.pendingCreates).toHaveLength(1);

    const dryRecovery = await runReconcile(roleOnlyConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: true,
    });
    expect(dryRecovery.plan.ops).toHaveLength(0);
    expect(fake.createdRoles).toHaveLength(1);
    expect((await manifestStore.load())?.pendingCreates).toHaveLength(1);

    const resumed = await runReconcile(roleOnlyConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(resumed.plan.ops).toHaveLength(0);
    expect(fake.createdRoles).toHaveLength(1);
    expect((await manifestStore.load())?.pendingCreates).toBeUndefined();
    expect((await manifestStore.load())?.bindings["roles.admin"]?.discordId).toBe(
      fake.createdRoles[0]?.id,
    );
  });

  it("recovers a channel created before the response was lost without duplicating it", async () => {
    const fake = new FakeDiscord({
      guild: freshGuild(),
      roles: [everyoneRole],
      config: { failAfterCreateChannel: true },
    });

    await expect(
      runReconcile(channelOnlyConfig, {
        port: fake,
        manifestStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toThrow(/Internal Server Error after channel creation/);

    expect(fake.createdChannels).toHaveLength(1);
    const resumed = await runReconcile(channelOnlyConfig, {
      port: fake,
      manifestStore,
      guildId: "123",
      dryRun: false,
    });

    expect(resumed.plan.ops).toHaveLength(0);
    expect(fake.createdChannels).toHaveLength(1);
  });

  it("fails closed when an ambiguous pending role has no exact unique candidate", async () => {
    const fake = new FakeDiscord({
      guild: freshGuild(),
      roles: [everyoneRole],
      config: { failAfterCreateRole: true },
    });

    await expect(
      runReconcile(roleOnlyConfig, {
        port: fake,
        manifestStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toThrow(/after role creation/);

    const created = fake.createdRoles[0];
    expect(created).toBeDefined();
    if (!created) throw new Error("expected a created role");
    fake.roles.push({ ...created, id: "2000" });

    await expect(
      runReconcile(roleOnlyConfig, {
        port: fake,
        manifestStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(PendingCreateRecoveryError);
    expect(fake.createdRoles).toHaveLength(1);
  });

  it("does not retry a pending create when no candidate remains live", async () => {
    const fake = new FakeDiscord({
      guild: freshGuild(),
      roles: [everyoneRole],
      config: { failAfterCreateRole: true },
    });

    await expect(
      runReconcile(roleOnlyConfig, {
        port: fake,
        manifestStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toThrow(/after role creation/);
    fake.roles = [everyoneRole];

    await expect(
      runReconcile(roleOnlyConfig, {
        port: fake,
        manifestStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(PendingCreateRecoveryError);
    expect(fake.createdRoles).toHaveLength(1);
    expect((await manifestStore.load())?.pendingCreates).toHaveLength(1);
  });

  it("recovers when the binding save fails after Discord created the role", async () => {
    const flakyStore = new FailOnceAfterPendingManifestStore(join(dir, "flaky-manifest.json"));
    const fake = new FakeDiscord({ guild: freshGuild(), roles: [everyoneRole] });

    await expect(
      runReconcile(roleOnlyConfig, {
        port: fake,
        manifestStore: flakyStore,
        guildId: "123",
        dryRun: false,
      }),
    ).rejects.toThrow(/simulated manifest failure/);

    expect(fake.createdRoles).toHaveLength(1);
    expect((await flakyStore.load())?.pendingCreates).toHaveLength(1);

    const resumed = await runReconcile(roleOnlyConfig, {
      port: fake,
      manifestStore: flakyStore,
      guildId: "123",
      dryRun: false,
    });
    expect(resumed.plan.ops).toHaveLength(0);
    expect(fake.createdRoles).toHaveLength(1);
  });
});
