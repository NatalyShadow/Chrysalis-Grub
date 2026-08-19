import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdoptError, adoptResource } from "../../src/identity/adopt.js";
import { DuplicateDiscordIdError, ManifestStore } from "../../src/identity/manifest.js";
import { resolveKey, resolveKeys, UnboundKeyError } from "../../src/identity/resolve.js";
import type { ManifestData } from "../../src/identity/types.js";

function manifestWith(bindings: ManifestData["bindings"]): ManifestData {
  return {
    meta: { schemaVersion: 1, guildId: "123", createdAt: "x", deletionPolicy: "never" },
    bindings,
  };
}

describe("resolveKeys (manifest-strict)", () => {
  it("resolves bound keys to snowflakes", () => {
    const manifest = manifestWith({
      "roles.male": {
        key: "male",
        aliases: [],
        kind: "role",
        discordId: "111",
        createdAt: "x",
      },
    });
    const result = resolveKeys(manifest, ["roles.male", "roles.female"]);
    expect(result.resolved).toEqual([{ logicalKey: "roles.male", discordId: "111" }]);
    expect(result.missing).toEqual(["roles.female"]);
  });

  it("resolveKey throws UnboundKeyError for an unbound key", () => {
    const manifest = manifestWith({});
    expect(() => resolveKey(manifest, "roles.male")).toThrow(UnboundKeyError);
  });

  it("never auto-adopts — unbound keys are reported, not bound", () => {
    const manifest = manifestWith({});
    const result = resolveKeys(manifest, ["channels.gaming"]);
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual(["channels.gaming"]);
    expect(Object.keys(manifest.bindings)).toHaveLength(0);
  });

  it("UnboundKeyError suggests the adopt command", () => {
    const manifest = manifestWith({});
    try {
      resolveKey(manifest, "roles.male");
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnboundKeyError);
      expect((error as UnboundKeyError).message).toContain("chrysalis adopt");
    }
  });
});

describe("adoptResource", () => {
  let dir: string;
  let store: ManifestStore;

  const candidates = (ids: string[]) => ids.map((id) => ({ discordId: id, name: "Hombre" }));

  const lookup = (results: { discordId: string; name: string }[]) => ({
    async listByName(_kind: "role" | "channel", _name: string) {
      return results;
    },
    async getById(_kind: "role" | "channel", discordId: string) {
      return results.find((entry) => entry.discordId === discordId) ?? null;
    },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-adopt-"));
    store = new ManifestStore(join(dir, "manifest.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("binds a unique name match and persists to the manifest", async () => {
    const manifest = await adoptResource({
      kind: "role",
      key: "male",
      name: "Hombre",
      lookup: lookup(candidates(["111"])),
      manifestStore: store,
      guildId: "123",
    });
    expect(manifest.bindings["roles.male"]).toMatchObject({
      key: "male",
      kind: "role",
      discordId: "111",
    });
    const reloaded = await store.load();
    expect(reloaded?.bindings["roles.male"]?.discordId).toBe("111");
  });

  it("aborts when nothing matches", async () => {
    await expect(
      adoptResource({
        kind: "role",
        key: "male",
        name: "Hombre",
        lookup: lookup([]),
        manifestStore: store,
      }),
    ).rejects.toThrow(AdoptError);
  });

  it("aborts loudly on ambiguous matches", async () => {
    await expect(
      adoptResource({
        kind: "channel",
        key: "gaming",
        name: "Gaming",
        lookup: lookup(candidates(["111", "222"])),
        manifestStore: store,
      }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("refuses to overwrite an existing binding", async () => {
    const manifest = manifestWith({
      "roles.male": {
        key: "male",
        aliases: [],
        kind: "role",
        discordId: "111",
        createdAt: "x",
      },
    });
    await store.save(manifest);
    await expect(
      adoptResource({
        kind: "role",
        key: "male",
        name: "Hombre",
        lookup: lookup(candidates(["999"])),
        manifestStore: store,
      }),
    ).rejects.toThrow(/already bound/);
  });

  it("refuses to bind an id already bound to another key", async () => {
    const manifest = manifestWith({
      "roles.male": {
        key: "male",
        aliases: [],
        kind: "role",
        discordId: "111",
        createdAt: "x",
      },
    });
    await store.save(manifest);
    await expect(
      adoptResource({
        kind: "role",
        key: "female",
        name: "Hombre",
        lookup: lookup(candidates(["111"])),
        manifestStore: store,
      }),
    ).rejects.toThrow(DuplicateDiscordIdError);
  });

  it("creates a fresh manifest when none exists", async () => {
    const manifest = await adoptResource({
      kind: "role",
      key: "male",
      name: "Hombre",
      lookup: lookup(candidates(["111"])),
      manifestStore: store,
      guildId: "123",
    });
    expect(manifest.meta.guildId).toBe("123");
    expect(manifest.meta.deletionPolicy).toBe("never");
  });
});

describe("adoptResource — by snowflake id", () => {
  let dir: string;
  let store: ManifestStore;

  const liveRole = { discordId: "999", name: "Hombre" };
  const lookup = {
    async listByName() {
      throw new Error("listByName must not be called when --id is provided");
    },
    async getById(_kind: "role" | "channel", discordId: string) {
      return discordId === liveRole.discordId ? liveRole : null;
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-adopt-id-"));
    store = new ManifestStore(join(dir, "manifest.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("binds a live resource by snowflake id without name matching", async () => {
    const manifest = await adoptResource({
      kind: "role",
      key: "hombre",
      discordId: "999",
      lookup,
      manifestStore: store,
      guildId: "123",
    });
    expect(manifest.bindings["roles.hombre"]).toMatchObject({
      key: "hombre",
      kind: "role",
      discordId: "999",
    });
  });

  it("aborts when the id does not exist in the live guild", async () => {
    await expect(
      adoptResource({
        kind: "role",
        key: "hombre",
        discordId: "000",
        lookup,
        manifestStore: store,
      }),
    ).rejects.toThrow(/no live role with id 000/);
  });

  it("rejects an id already bound to another key", async () => {
    const manifest = manifestWith({
      "roles.male": {
        key: "male",
        aliases: [],
        kind: "role",
        discordId: "999",
        createdAt: "x",
      },
    });
    await store.save(manifest);
    await expect(
      adoptResource({
        kind: "role",
        key: "hombre",
        discordId: "999",
        lookup,
        manifestStore: store,
      }),
    ).rejects.toThrow(DuplicateDiscordIdError);
  });

  it("refuses to overwrite an existing binding when adopting by id", async () => {
    const manifest = manifestWith({
      "roles.hombre": {
        key: "hombre",
        aliases: [],
        kind: "role",
        discordId: "999",
        createdAt: "x",
      },
    });
    await store.save(manifest);
    await expect(
      adoptResource({
        kind: "role",
        key: "hombre",
        discordId: "999",
        lookup,
        manifestStore: store,
      }),
    ).rejects.toThrow(/already bound/);
  });

  it("fails when neither name nor id is provided", async () => {
    await expect(
      adoptResource({
        kind: "role",
        key: "hombre",
        lookup,
        manifestStore: store,
      }),
    ).rejects.toThrow(/or --id/);
  });
});
