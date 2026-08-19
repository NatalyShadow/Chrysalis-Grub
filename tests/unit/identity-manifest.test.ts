import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completePendingCreate,
  DuplicateDiscordIdError,
  ManifestInvalidError,
  ManifestLockError,
  ManifestStore,
  type PendingCreate,
  validateManifest,
} from "../../src/identity/manifest.js";
import type { ManifestData } from "../../src/identity/types.js";

describe("ManifestStore", () => {
  let dir: string;
  let store: ManifestStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-manifest-"));
    store = new ManifestStore(join(dir, ".chrysalis", "manifest.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the manifest does not exist", async () => {
    expect(await store.load()).toBeNull();
  });

  it("round-trips bindings through save/load", async () => {
    const data: ManifestData = {
      meta: {
        schemaVersion: 1,
        guildId: "123",
        createdAt: new Date().toISOString(),
        deletionPolicy: "never",
      },
      bindings: {
        "roles.male": {
          key: "male",
          aliases: [],
          kind: "role",
          discordId: "111",
          createdAt: new Date().toISOString(),
        },
        "channels.gaming": {
          key: "gaming",
          aliases: [],
          kind: "channel",
          discordId: "222",
          createdAt: new Date().toISOString(),
        },
      },
    };
    await store.save(data);
    const loaded = await store.load();
    expect(loaded).toEqual(data);
  });

  it("writes the manifest atomically (no .tmp left behind)", async () => {
    const data = ManifestStore.empty("123");
    await store.save(data);
    const files = await import("node:fs/promises").then((m) => m.readdir(dir));
    expect(files).not.toContain("manifest.json.tmp");
  });

  it("rejects an invalid manifest on load", async () => {
    const bad: ManifestData = {
      meta: { schemaVersion: 999, createdAt: "x", deletionPolicy: "never" },
      bindings: {},
    };
    await import("node:fs/promises").then((m) => m.mkdir(dirname(store.path), { recursive: true }));
    await writeFile(store.path, JSON.stringify(bad));
    await expect(store.load()).rejects.toThrow(ManifestInvalidError);
  });

  it("empty() creates a default manifest", () => {
    const data = ManifestStore.empty("123");
    expect(data.meta.schemaVersion).toBe(1);
    expect(data.meta.deletionPolicy).toBe("never");
    expect(data.bindings).toEqual({});
  });

  it("persists and completes a pending create binding", async () => {
    const pending: PendingCreate = {
      operationId: "roles.male:create",
      kind: "role",
      key: "male",
      logicalKey: "roles.male",
      fingerprint: "fingerprint",
      resourceName: "Male",
      createdAt: "2026-08-17T00:00:00.000Z",
      status: "unknown",
    };
    const data = ManifestStore.empty("123");
    data.pendingCreates = [pending];
    await store.save(data);

    const loaded = await store.load();
    expect(loaded?.pendingCreates).toHaveLength(1);
    if (!loaded) throw new Error("expected a persisted manifest");
    completePendingCreate(loaded, "role", "male", "111");
    await store.save(loaded);

    const recovered = await store.load();
    expect(recovered?.bindings["roles.male"]?.discordId).toBe("111");
    expect(recovered?.pendingCreates).toBeUndefined();
  });

  it("rejects concurrent manifest locks", async () => {
    const first = await store.acquireLock();
    await expect(store.acquireLock()).rejects.toBeInstanceOf(ManifestLockError);
    await first.release();
    const second = await store.acquireLock();
    await second.release();
  });

  it("clears a lock left by a dead process", async () => {
    await mkdir(dirname(store.lockPath), { recursive: true });
    await import("node:fs/promises").then((fs) => fs.writeFile(store.lockPath, "999999999\n"));
    const lock = await store.acquireLock();
    await lock.release();
  });
});

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const data: ManifestData = {
      meta: { schemaVersion: 1, createdAt: "x", deletionPolicy: "never" },
      bindings: {
        "roles.male": {
          key: "male",
          aliases: [],
          kind: "role",
          discordId: "111",
          createdAt: "x",
        },
      },
    };
    const result = validateManifest(data);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects malformed logical keys", () => {
    const data: ManifestData = {
      meta: { schemaVersion: 1, createdAt: "x", deletionPolicy: "never" },
      bindings: {
        weird: {
          key: "weird",
          aliases: [],
          kind: "role",
          discordId: "111",
          createdAt: "x",
        },
      },
    };
    expect(validateManifest(data).ok).toBe(false);
  });

  it("rejects shared discordIds", () => {
    const data: ManifestData = {
      meta: { schemaVersion: 1, createdAt: "x", deletionPolicy: "never" },
      bindings: {
        "roles.male": {
          key: "male",
          aliases: [],
          kind: "role",
          discordId: "111",
          createdAt: "x",
        },
        "roles.female": {
          key: "female",
          aliases: [],
          kind: "role",
          discordId: "111",
          createdAt: "x",
        },
      },
    };
    const result = validateManifest(data);
    expect(result.ok).toBe(false);
    expect(result.invariants.discordIdsUnique).toBe(false);
    expect(result.errors.some((error) => error.includes("shared by"))).toBe(true);
  });

  it("rejects an unsupported schemaVersion", () => {
    const data: ManifestData = {
      meta: { schemaVersion: 2, createdAt: "x", deletionPolicy: "never" },
      bindings: {},
    };
    expect(validateManifest(data).ok).toBe(false);
  });
});

describe("DuplicateDiscordIdError", () => {
  it("carries the conflicting keys", () => {
    const error = new DuplicateDiscordIdError("111", "roles.male", "roles.female");
    expect(error.discordId).toBe("111");
    expect(error.existingKey).toBe("roles.male");
    expect(error.newKey).toBe("roles.female");
  });
});
