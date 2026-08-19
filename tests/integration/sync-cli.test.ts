import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDiscord } from "../../src/adapters/fake-adapter.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { runSyncCli } from "../../src/cli/sync.js";
import { ManifestStore } from "../../src/identity/manifest.js";
import type { ApiChannel, ApiOnboarding, ApiRole } from "../../src/port/discord-types.js";

/**
 * `chrysalis sync` — read-only export of the source guild into ID-free config
 * fragments (`guild.json`, `roles.json`, `channels.json`), writes
 * `.chrysalis/clone-source.json` traceability and merges every captured
 * key → snowflake binding into the source manifest (`manifest.json`).
 */

const everyoneRole: ApiRole = { id: "123", name: "@everyone", permissions: "2048" };
const maleRole: ApiRole = { id: "100", name: "MALE", permissions: "0" };

function seedFake(): FakeDiscord {
  const channels: ApiChannel[] = [
    { id: "1", name: "INFO", type: 4 },
    { id: "2", name: "general", type: 0, parent_id: "1" },
    { id: "3", name: "gaming", type: 0, parent_id: "1" },
    { id: "4", name: "SERVER STATS", type: 2 },
  ];
  return new FakeDiscord({
    guild: { id: "123", name: "Grub NSFW", features: [] },
    roles: [everyoneRole, maleRole],
    channels,
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("runSyncCli — export the source guild into config/clone", () => {
  let dir: string;
  let outputDir: string;
  let stateDir: string;
  let sourceManifestStore: ManifestStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-sync-cli-"));
    outputDir = join(dir, "clone");
    stateDir = join(dir, ".chrysalis");
    sourceManifestStore = new ManifestStore(join(stateDir, "manifest.json"));
    await sourceManifestStore.save(ManifestStore.empty("123"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes guild.json, roles.json and channels.json fragments", async () => {
    const fake = seedFake();
    const code = await runSyncCli({
      port: fake,
      guildId: "123",
      sourceManifestStore,
      outputDir,
      stateDir,
      excludeRoles: [],
      excludeChannels: [],
    });
    expect(code).toBe(ExitCode.Converged);

    const guild = (await readJson(join(outputDir, "guild.json"))) as { guild: { name: string } };
    expect(guild.guild.name).toBe("Grub NSFW");

    const roles = (await readJson(join(outputDir, "roles.json"))) as {
      roles: { roles: ApiRole[] };
    };
    expect(roles.roles.roles).toHaveLength(1); // @everyone is skipped
    expect(roles.roles.roles[0]?.name).toBe("MALE");

    const channels = (await readJson(join(outputDir, "channels.json"))) as {
      channels: { categories: ApiChannel[]; channels: ApiChannel[] };
    };
    expect(channels.channels.categories).toHaveLength(1);
    expect(channels.channels.channels).toHaveLength(3);
  });

  it("writes .chrysalis/clone-source.json with source guild id and bindings", async () => {
    const fake = seedFake();
    const code = await runSyncCli({
      port: fake,
      guildId: "123",
      sourceManifestStore,
      outputDir,
      stateDir,
      excludeRoles: [],
      excludeChannels: [],
    });
    expect(code).toBe(ExitCode.Converged);

    const trace = (await readJson(join(stateDir, "clone-source.json"))) as {
      sourceGuildId: string;
      bindings: Record<string, string>;
    };
    expect(trace.sourceGuildId).toBe("123");
    expect(trace.bindings["roles.male"]).toBe("100");
    expect(trace.bindings["channels.info"]).toBe("1");
    expect(trace.bindings["channels.general"]).toBe("2");
  });

  it("merges captured bindings into the source manifest", async () => {
    const fake = seedFake();
    const code = await runSyncCli({
      port: fake,
      guildId: "123",
      sourceManifestStore,
      outputDir,
      stateDir,
      excludeRoles: [],
      excludeChannels: [],
    });
    expect(code).toBe(ExitCode.Converged);

    const manifest = await sourceManifestStore.load();
    expect(manifest).not.toBeNull();
    expect(manifest?.bindings["roles.male"]?.discordId).toBe("100");
    expect(manifest?.bindings["channels.general"]?.discordId).toBe("2");
  });

  it("applies --exclude-role and --exclude-channel by name", async () => {
    const fake = seedFake();
    const code = await runSyncCli({
      port: fake,
      guildId: "123",
      sourceManifestStore,
      outputDir,
      stateDir,
      excludeRoles: ["MALE"],
      excludeChannels: ["SERVER STATS"],
    });
    expect(code).toBe(ExitCode.Converged);

    const roles = (await readJson(join(outputDir, "roles.json"))) as {
      roles: { roles: ApiRole[] };
    };
    expect(roles.roles.roles).toHaveLength(0);

    const channels = (await readJson(join(outputDir, "channels.json"))) as {
      channels: { categories: ApiChannel[]; channels: ApiChannel[] };
    };
    expect(channels.channels.channels.some((c) => c.name === "SERVER STATS")).toBe(false);
  });

  it("returns ExitCode.Error when the guild cannot be read", async () => {
    const fake = seedFake();
    const code = await runSyncCli({
      port: fake,
      guildId: "404", // FakeDiscord rejects any guild id different from "123"
      sourceManifestStore,
      outputDir,
      stateDir,
      excludeRoles: [],
      excludeChannels: [],
    });
    expect(code).toBe(ExitCode.Error);
  });

  it("writes onboarding.json + one prompt-<key>.json per prompt", async () => {
    const onboarding: ApiOnboarding = {
      guild_id: "123",
      enabled: true,
      mode: 1,
      default_channel_ids: ["2", "3"],
      // The separator role must be present in every option; role 101 is shared
      // by both options while each grants its own specific role.
      prompts: [
        {
          id: "p1",
          title: "「⋆｡˚❀▪WHAT GENDER DO YOU IDENTIFY WITH?▪❀˚｡⋆」",
          type: 0,
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              id: "o1",
              title: "MAN",
              description: "",
              emoji: { id: null, name: "♂️", animated: false },
              role_ids: ["101", "100"],
              channel_ids: ["2"],
            },
            {
              id: "o2",
              title: "WOMAN",
              description: "",
              emoji: { id: null, name: "♀️", animated: false },
              role_ids: ["101", "102"],
              channel_ids: [],
            },
          ],
        },
      ],
    };
    const fake = new FakeDiscord({
      guild: { id: "123", name: "Grub NSFW", features: [] },
      roles: [
        { id: "123", name: "@everyone", permissions: "2048" },
        { id: "100", name: "MALE", permissions: "0" },
        { id: "101", name: "───────ஓ๑GENDER๑ஓ ───────", permissions: "0" },
        { id: "102", name: "FEMALE", permissions: "0" },
      ],
      channels: [
        { id: "1", name: "INFO", type: 4 },
        { id: "2", name: "general", type: 0, parent_id: "1" },
        { id: "3", name: "gaming", type: 0, parent_id: "1" },
        { id: "4", name: "SERVER STATS", type: 2 },
      ],
      onboarding,
    });

    const code = await runSyncCli({
      port: fake,
      guildId: "123",
      sourceManifestStore,
      outputDir,
      stateDir,
      excludeRoles: [],
      excludeChannels: [],
    });
    expect(code).toBe(ExitCode.Converged);

    const base = (await readJson(join(outputDir, "onboarding.json"))) as {
      onboarding: { enabled: boolean; mode: string; defaultChannels: string[] };
    };
    expect(base.onboarding).toMatchObject({
      enabled: true,
      mode: "ONBOARDING_ADVANCED",
      defaultChannels: ["general", "gaming"],
    });

    const prompt = (await readJson(join(outputDir, "prompt-gender.json"))) as {
      onboarding: {
        prompts: [
          {
            key: string;
            separatorRole: string;
            options: Array<{ key: string; roles?: string[]; channels?: string[] }>;
          },
        ];
      };
    };
    const gender = prompt.onboarding.prompts[0];
    expect(gender.key).toBe("gender");
    expect(gender.separatorRole).toBe("gender");
    expect(gender.options[0]).toMatchObject({ key: "male", roles: ["male"] });
    expect(gender.options[0]?.channels).toEqual(["general"]);
    expect(gender.options[1]).toMatchObject({ key: "female", roles: ["female"] });
  });
});
