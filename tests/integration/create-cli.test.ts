import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDiscord } from "../../src/adapters/fake-adapter.js";
import { runCreateCli } from "../../src/cli/create.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { Journal } from "../../src/identity/journal.js";
import { ManifestStore } from "../../src/identity/manifest.js";
import type { ApiGuild } from "../../src/port/discord-types.js";

/**
 * `chrysalis create` — create-and-bind on the TARGET guild against
 * `.chrysalis/manifest.clone.json`. The plan phase must always run in
 * dry-run; the only mutation happens AFTER the confirmation gate.
 */

/** @everyone role: id === guildId, SEND_MESSAGES (2048) + VIEW_CHANNEL (1024)
 *  base perms (Discord's @everyone always has both). */
const everyoneRole = { id: "123", name: "@everyone", permissions: "3072" };

const cloneConfig = {
  guild: { name: "Grub NSFW" },
  roles: { roles: [{ key: "admin", name: "Admin", permissions: "8" }], ordering: ["admin"] },
  channels: {
    categories: [{ key: "cat-info", name: "INFO", type: 4 }],
    channels: [
      { key: "general", name: "general", type: 0, parent: "cat-info" },
      { key: "gaming", name: "gaming", type: 0, parent: "cat-info" },
      { key: "announcements", name: "announcements", type: 0, parent: "cat-info" },
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
        options: [{ key: "chat", title: "Chat", roles: ["admin"] }],
      },
    ],
  },
};

function freshGuild(): ApiGuild {
  return {
    id: "123",
    name: "Grub NSFW",
    features: [],
    verification_level: 1,
    explicit_content_filter: 1,
    default_message_notifications: 1,
    preferred_locale: "en-US",
    rules_channel_id: null,
    public_updates_channel_id: null,
  };
}

function seedCloneFake(): FakeDiscord {
  return new FakeDiscord({ guild: freshGuild(), roles: [everyoneRole] });
}

describe("runCreateCli — create-and-bind on the target", () => {
  let dir: string;
  let manifestStore: ManifestStore;
  let journal: Journal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-create-cli-"));
    manifestStore = new ManifestStore(join(dir, "manifest.clone.json"));
    journal = new Journal(join(dir, "journal.clone.jsonl"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does NOT create anything when the user declines (regression)", async () => {
    const fake = seedCloneFake();
    const code = await runCreateCli({
      port: fake,
      manifestStore,
      guildId: "123",
      config: cloneConfig,
      journal,
      dryRun: false,
      yes: false,
      confirm: async () => false,
    });
    expect(code).toBe(ExitCode.Error);
    expect(fake.createdRoles).toHaveLength(0);
    expect(fake.createdChannels).toHaveLength(0);
  });

  it("creates roles and channels only after confirmation", async () => {
    const fake = seedCloneFake();
    const code = await runCreateCli({
      port: fake,
      manifestStore,
      guildId: "123",
      config: cloneConfig,
      journal,
      dryRun: false,
      yes: false,
      confirm: async () => true,
    });
    expect(code).toBe(ExitCode.Changes);
    expect(fake.createdRoles).toHaveLength(1);
    expect(fake.createdChannels).toHaveLength(8); // category + 7 children
  });

  it("--dry-run plans but never creates", async () => {
    const fake = seedCloneFake();
    const code = await runCreateCli({
      port: fake,
      manifestStore,
      guildId: "123",
      config: cloneConfig,
      journal,
      dryRun: true,
      yes: false,
    });
    expect(code).toBe(ExitCode.Changes);
    expect(fake.createdRoles).toHaveLength(0);
    expect(fake.createdChannels).toHaveLength(0);
  });

  it("converges to exit 0 on a re-run (create-and-bind + onboarding NOOP)", async () => {
    const fake = seedCloneFake();
    const first = await runCreateCli({
      port: fake,
      manifestStore,
      guildId: "123",
      config: cloneConfig,
      journal,
      dryRun: false,
      yes: true,
    });
    expect(first).toBe(ExitCode.Changes);
    expect(fake.createdRoles).toHaveLength(1);
    expect(fake.createdChannels).toHaveLength(8);

    const second = await runCreateCli({
      port: fake,
      manifestStore,
      guildId: "123",
      config: cloneConfig,
      journal,
      dryRun: false,
      yes: true,
    });
    expect(second).toBe(ExitCode.Converged);
  });
});
