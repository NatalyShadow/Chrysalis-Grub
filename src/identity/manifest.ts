import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type Binding,
  type BindingKind,
  MANIFEST_SCHEMA_VERSION,
  type ManifestData,
  type ManifestValidation,
  type PendingCreate,
} from "./types.js";

export type { Binding, ManifestData, ManifestValidation, PendingCreate } from "./types.js";
export { MANIFEST_SCHEMA_VERSION } from "./types.js";

/**
 * Manifest (ADR-001 §2): `.chrysalis/manifest.json`, committed to git, written
 * atomically (temp file in same dir → fsync → rename → fsync dir).
 */
export class ManifestStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  get lockPath(): string {
    return `${this.filePath}.lock`;
  }

  async load(): Promise<ManifestData | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const data = JSON.parse(raw) as ManifestData;
    const validation = validateManifest(data);
    if (!validation.ok) {
      throw new ManifestInvalidError(validation.errors);
    }
    return data;
  }

  async save(data: ManifestData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fsync(tmpPath);
    await rename(tmpPath, this.filePath);
    await fsync(dirname(this.filePath));
  }

  /**
   * Acquire an exclusive process lock for a load/plan/apply cycle.
   *
   * Discord creates are not idempotent and therefore two concurrent create
   * runs must never be allowed to plan against the same manifest.
   */
  async acquireLock(): Promise<ManifestLock> {
    await mkdir(dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(this.lockPath, "wx");
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.close();
        return new ManifestLock(this.lockPath);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          if (attempt === 0 && (await isStaleLock(this.lockPath))) {
            await unlink(this.lockPath).catch(() => undefined);
            continue;
          }
          throw new ManifestLockError(this.lockPath);
        }
        await unlink(this.lockPath).catch(() => undefined);
        throw error;
      }
    }
    throw new ManifestLockError(this.lockPath);
  }

  static empty(guildId?: string): ManifestData {
    return {
      meta: {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        guildId,
        createdAt: new Date().toISOString(),
        deletionPolicy: "never",
      },
      bindings: {},
    };
  }
}

export class ManifestInvalidError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`manifest invalid: ${errors.join("; ")}`);
    this.name = "ManifestInvalidError";
    this.errors = errors;
  }
}

export class DuplicateDiscordIdError extends Error {
  public readonly discordId: string;
  public readonly existingKey: string;
  public readonly newKey: string;

  constructor(discordId: string, existingKey: string, newKey: string) {
    super(`discordId ${discordId} already bound to "${existingKey}" (rejected for "${newKey}")`);
    this.name = "DuplicateDiscordIdError";
    this.discordId = discordId;
    this.existingKey = existingKey;
    this.newKey = newKey;
  }
}

export class ManifestLockError extends Error {
  public readonly lockPath: string;

  constructor(lockPath: string) {
    super(`manifest is locked by another Chrysalis run: ${lockPath}`);
    this.name = "ManifestLockError";
    this.lockPath = lockPath;
  }
}

export class ManifestPendingCreateError extends Error {
  public readonly logicalKey: string;

  constructor(logicalKey: string, message: string) {
    super(message);
    this.name = "ManifestPendingCreateError";
    this.logicalKey = logicalKey;
  }
}

/** A releasable lock returned by ManifestStore.acquireLock(). */
export class ManifestLock {
  private released = false;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Validate manifest invariants (ADR-001 §3):
 * - schemaVersion supported
 * - logical keys well-formed and unique
 * - discordId unique across bindings
 */
export function validateManifest(data: ManifestData): ManifestValidation {
  const errors: string[] = [];

  if (data.meta.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(
      `unsupported schemaVersion ${data.meta.schemaVersion} (expected ${MANIFEST_SCHEMA_VERSION})`,
    );
  }

  for (const logicalKey of Object.keys(data.bindings)) {
    const dot = logicalKey.indexOf(".");
    const kind = dot === -1 ? "" : logicalKey.slice(0, dot);
    const key = dot === -1 ? logicalKey : logicalKey.slice(dot + 1);
    if (!["roles", "channels"].includes(kind) || key === "") {
      errors.push(`malformed logical key "${logicalKey}"`);
    }
  }

  const byId = new Map<string, string>();
  for (const [logicalKey, binding] of Object.entries(data.bindings)) {
    if (!binding || typeof binding.discordId !== "string" || binding.discordId === "") {
      errors.push(`binding "${logicalKey}" missing discordId`);
      continue;
    }
    const dot = logicalKey.indexOf(".");
    const expectedKind = dot === -1 ? "" : logicalKey.slice(0, dot);
    const expectedBindingKind: BindingKind | "" =
      expectedKind === "roles" ? "role" : expectedKind === "channels" ? "channel" : "";
    if (expectedBindingKind !== "" && binding.kind !== expectedBindingKind) {
      errors.push(
        `binding "${logicalKey}" has kind "${binding.kind}" but expected "${expectedBindingKind}"`,
      );
    }
    const previous = byId.get(binding.discordId);
    if (previous) {
      errors.push(`discordId ${binding.discordId} shared by "${previous}" and "${logicalKey}"`);
    } else {
      byId.set(binding.discordId, logicalKey);
    }
  }

  validatePendingCreates(data.pendingCreates, errors, data.bindings);

  return {
    ok: errors.length === 0,
    invariants: {
      schemaVersionSupported: data.meta.schemaVersion === MANIFEST_SCHEMA_VERSION,
      keysValid: !errors.some((error) => error.startsWith("malformed")),
      discordIdsUnique: !errors.some((error) => error.includes("shared by")),
    },
    errors,
  };
}

function validatePendingCreates(
  pendingCreates: PendingCreate[] | undefined,
  errors: string[],
  bindings: Record<string, Binding>,
): void {
  if (pendingCreates === undefined) return;
  if (!Array.isArray(pendingCreates)) {
    errors.push("pendingCreates must be an array");
    return;
  }
  const operationIds = new Set<string>();
  const logicalKeys = new Set<string>();
  for (const pending of pendingCreates) {
    if (pending.operationId === "" || operationIds.has(pending.operationId)) {
      errors.push(`duplicate or empty pending create operationId "${pending.operationId}"`);
    }
    operationIds.add(pending.operationId);
    if (pending.key === "" || pending.logicalKey === "") {
      errors.push(`pending create "${pending.operationId}" has an empty logical key`);
    }
    const expectedPrefix = pending.kind === "role" ? "roles." : "channels.";
    if (pending.kind !== "role" && pending.kind !== "channel") {
      errors.push(`pending create "${pending.operationId}" has an invalid kind`);
    } else if (!pending.logicalKey.startsWith(expectedPrefix)) {
      errors.push(
        `pending create "${pending.operationId}" logical key "${pending.logicalKey}" does not match kind "${pending.kind}"`,
      );
    }
    if (pending.status !== "prepared" && pending.status !== "unknown") {
      errors.push(`pending create "${pending.operationId}" has an invalid status`);
    }
    if (logicalKeys.has(pending.logicalKey)) {
      errors.push(`multiple pending creates share logical key "${pending.logicalKey}"`);
    }
    logicalKeys.add(pending.logicalKey);
    if (bindings[pending.logicalKey] !== undefined) {
      errors.push(
        `pending create "${pending.operationId}" conflicts with existing binding "${pending.logicalKey}"`,
      );
    }
    if (pending.fingerprint === "" || pending.resourceName === "") {
      errors.push(`pending create "${pending.operationId}" is missing recovery metadata`);
    }
  }
}

/** Add a pending create to a manifest in memory. Persist with ManifestStore.save(). */
export function addPendingCreate(manifest: ManifestData, pending: PendingCreate): void {
  const pendingCreates = manifest.pendingCreates ?? [];
  if (pendingCreates.some((entry) => entry.logicalKey === pending.logicalKey)) {
    throw new ManifestPendingCreateError(
      pending.logicalKey,
      `logical key "${pending.logicalKey}" already has a pending create`,
    );
  }
  manifest.pendingCreates = [...pendingCreates, pending];
}

/** Remove a completed pending create from a manifest in memory. */
export function removePendingCreate(manifest: ManifestData, operationId: string): void {
  const pendingCreates = manifest.pendingCreates ?? [];
  const remaining = pendingCreates.filter((entry) => entry.operationId !== operationId);
  if (remaining.length === 0) {
    delete manifest.pendingCreates;
  } else {
    manifest.pendingCreates = remaining;
  }
}

/** Mark a pending create as outcome-unknown without clearing its recovery intent. */
export function markPendingCreateUnknown(
  manifest: ManifestData,
  operationId: string,
  errorMessage: string,
): void {
  const pending = manifest.pendingCreates?.find((entry) => entry.operationId === operationId);
  if (!pending) return;
  pending.status = "unknown";
  pending.lastError = errorMessage;
}

/**
 * Complete a pending create from an explicit operator-confirmed snowflake.
 * This is used by the recovery CLI, not by normal name-based adoption.
 */
export function completePendingCreate(
  manifest: ManifestData,
  kind: BindingKind,
  key: string,
  discordId: string,
): void {
  const logicalKey = `${kind === "role" ? "roles" : "channels"}.${key}`;
  const pending = manifest.pendingCreates?.find((entry) => entry.logicalKey === logicalKey);
  if (!pending) {
    throw new ManifestPendingCreateError(
      logicalKey,
      `no pending create exists for "${logicalKey}"`,
    );
  }
  if (pending.kind !== kind || pending.key !== key) {
    throw new ManifestPendingCreateError(
      logicalKey,
      `pending create metadata does not match "${logicalKey}"`,
    );
  }
  const conflict = Object.entries(manifest.bindings).find(
    ([existingKey, binding]) => binding.discordId === discordId && existingKey !== logicalKey,
  );
  if (conflict) {
    throw new DuplicateDiscordIdError(discordId, conflict[0], logicalKey);
  }
  manifest.bindings[logicalKey] = {
    key,
    aliases: [],
    kind,
    discordId,
    createdAt: pending.createdAt,
  };
  removePendingCreate(manifest, pending.operationId);
}

async function fsync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
