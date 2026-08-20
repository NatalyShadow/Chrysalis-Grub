import { ZodError } from "zod";

import { loadConfig } from "../config/load.js";
import type {
  ValidatedChannel,
  ValidatedChannels,
  ValidatedGuildSettings,
  ValidatedRole,
  ValidatedRoles,
} from "../config/schema/onboarding.js";
import type { SemanticResult } from "../config/semantic.js";
import { EVERYONE_REF } from "../config/types.js";
import type { Journal } from "../identity/journal.js";
import {
  addPendingCreate,
  type Binding,
  type ManifestData,
  ManifestStore,
  markPendingCreateUnknown,
  removePendingCreate,
} from "../identity/manifest.js";
import type { PendingCreate } from "../identity/types.js";
import type { DiscordPort } from "../port/discord-port.js";
import type {
  ApiChannel,
  ApiGuild,
  ApiPermissionOverwrite,
  ApiRole,
  ChannelCreateBody,
  ChannelPatchBody,
  ChannelPositionEntry,
  ChannelTagBody,
  GuildPatchBody,
  RoleCreateBody,
  RolePatchBody,
  RolePositionEntry,
} from "../port/discord-types.js";
import { ConfigError, type EngineResult, MissingBindingsError, runEngine } from "./engine.js";

/**
 * Reconcile orchestrator (docs/clone-server.md, Phase 2; unified with `sync`).
 *
 * Idempotent, multi-kind reconciler with create-and-bind:
 * - every resource declared in the spec is either created (POST → bind the new
 *   snowflake in the target manifest) or, if already bound and alive, diffed
 *   for drift (PATCH). Nothing is ever deleted.
 * - a crash mid-run leaves a partial manifest; the next run continues where it
 *   left off (bound + alive resources are skipped).
 * - the onboarding aggregate reuses the existing engine (`runEngine`) once all
 *   roles/channels exist.
 */

export interface CreateOptions {
  port: DiscordPort;
  manifestStore: ManifestStore;
  guildId: string;
  dryRun: boolean;
  journal?: Journal;
  reasonSuffix?: string;
}

/** A create-channel plan op carries authored refs; resolved at execution time. */
export interface ChannelCreatePayload {
  name: string;
  type: number;
  topic?: string | undefined;
  nsfw?: boolean | undefined;
  rateLimitPerUser?: number | undefined;
  bitrate?: number | undefined;
  userLimit?: number | undefined;
  videoQualityMode?: number | undefined;
  defaultAutoArchiveDuration?: number | undefined;
  availableTags?:
    | Array<{
        name: string;
        emojiName?: string | undefined;
        emojiId?: string | null | undefined;
        moderated?: boolean | undefined;
      }>
    | undefined;
  parentRef?: string | undefined;
  overwrites?:
    | Array<{ ref: string; allow?: string | undefined; deny?: string | undefined }>
    | undefined;
}

export type CreateOp =
  | { op: "create-role"; key: string; body: RoleCreateBody }
  | { op: "update-role"; key: string; discordId: string; patch: RolePatchBody }
  | { op: "reorder-roles"; entries: RolePositionEntry[] }
  | { op: "create-channel"; key: string; payload: ChannelCreatePayload }
  | { op: "update-channel"; key: string; discordId: string; patch: ChannelPatchBody }
  | { op: "reorder-channels"; entries: ChannelPositionEntry[] }
  | { op: "patch-guild"; patch: GuildPatchBody }
  | {
      op: "enable-community";
      rulesChannelRef: string;
      publicUpdatesChannelRef: string;
    };

export interface CreatePlan {
  ops: CreateOp[];
  /** Live resources not tracked by the manifest — left untouched. */
  untrackedRoles: string[];
  untrackedChannels: string[];
  warnings: string[];
  /** Position patch must be rebuilt after creates receive their snowflakes. */
  deferredChannelOrdering: boolean;
  /** Role position settle must run post-execute (roles created this run). */
  deferredRoleOrdering: boolean;
}

export interface CreateResult {
  plan: CreatePlan;
  applied: number;
  manifest: ManifestData;
  /** Onboarding apply result (present when the spec declares onboarding). */
  onboarding?: EngineResult;
  /** Dry-run note when onboarding bindings cannot resolve yet. */
  onboardingNote?: string;
}

export class CreateError extends Error {
  public readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CreateError";
    this.kind = kind;
  }
}

export interface PendingRecoveryCandidate {
  id: string;
  name: string;
}

export class PendingCreateRecoveryError extends CreateError {
  public readonly logicalKey: string;
  public readonly candidates: PendingRecoveryCandidate[];

  constructor(logicalKey: string, candidates: PendingRecoveryCandidate[], detail: string) {
    super(
      "pending-create-recovery",
      `cannot safely recover pending create "${logicalKey}": ${detail}. ` +
        `Inspect Discord and resolve it explicitly with "chrysalis recover-pending ${logicalKey} --id <snowflake>".`,
    );
    this.logicalKey = logicalKey;
    this.candidates = candidates;
  }
}

export async function runReconcile(
  rawConfig: unknown,
  options: CreateOptions,
): Promise<CreateResult> {
  if (options.dryRun) {
    return runReconcileUnlocked(rawConfig, options);
  }
  const lock = await options.manifestStore.acquireLock();
  try {
    return await runReconcileUnlocked(rawConfig, options);
  } finally {
    await lock.release();
  }
}

async function runReconcileUnlocked(
  rawConfig: unknown,
  options: CreateOptions,
): Promise<CreateResult> {
  // Phases 1–2: load + validate (offline).
  let semantic: SemanticResult;
  try {
    semantic = loadConfig(rawConfig).semantic;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(
        error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      );
    }
    throw error;
  }
  if (semantic.errors.length > 0) {
    throw new ConfigError(semantic.errors.map((issue) => `[${issue.path}] ${issue.message}`));
  }

  const [guild, roles, channels] = await Promise.all([
    options.port.getGuild(options.guildId),
    options.port.listRoles(options.guildId),
    options.port.listChannels(options.guildId),
  ]);

  const loadedManifest =
    (await options.manifestStore.load()) ?? ManifestStore.empty(options.guildId);
  const manifest = await recoverPendingCreates(
    semantic,
    { guild, roles, channels },
    loadedManifest,
    options,
  );

  const plan = buildCreatePlan(
    {
      ...(semantic.guild ? { guild: semantic.guild } : {}),
      ...(semantic.roles ? { roles: semantic.roles } : {}),
      ...(semantic.channels ? { channels: semantic.channels } : {}),
    },
    { guild, roles, channels },
    manifest,
  );

  if (options.dryRun) {
    const onboarding =
      semantic.onboarding.prompts.length > 0
        ? await dryRunOnboarding(rawConfig, options, manifest)
        : undefined;
    return {
      plan,
      applied: 0,
      manifest,
      ...(onboarding ? onboarding : {}),
    };
  }

  const executedManifest = await executeOps(plan.ops, options, manifest);
  let applied = plan.ops.length;
  if (!options.dryRun && plan.deferredChannelOrdering && semantic.channels) {
    const currentChannels = await options.port.listChannels(options.guildId);
    const deferredPositionPlan = buildChannelPositionPlan(
      semantic.channels,
      currentChannels,
      executedManifest,
    );
    if (deferredPositionPlan.op) {
      await executeOps([deferredPositionPlan.op], options, executedManifest);
      applied += 1;
    }
  }
  if (!options.dryRun && plan.deferredRoleOrdering && semantic.roles) {
    const currentRoles = await options.port.listRoles(options.guildId);
    const deferredRolePlan = buildRolePositionPlan(semantic.roles, currentRoles, executedManifest);
    if (deferredRolePlan.op) {
      await executeOps([deferredRolePlan.op], options, executedManifest);
      applied += 1;
    }
  }

  let onboardingResult: EngineResult | undefined;
  if (semantic.onboarding.prompts.length > 0) {
    // Exact copy: defaultChannels are private (verify role). Make them
    // temporarily visible to @everyone for the PUT, then revert to private
    // so the clone stays identical to the source (no commit, config stays ignored).
    const tempVisibility = await ensureDefaultChannelsVisibleForOnboarding(
      semantic,
      executedManifest,
      options,
    );
    try {
      onboardingResult = await runEngine(rawConfig, {
        port: options.port,
        manifest: executedManifest,
        guildId: options.guildId,
        dryRun: false,
        ...(options.journal ? { journal: options.journal } : {}),
        ...(options.reasonSuffix ? { reasonSuffix: options.reasonSuffix } : {}),
      });
    } finally {
      await restoreDefaultChannelsVisibility(tempVisibility, options);
    }
  }

  return {
    plan,
    applied,
    manifest: executedManifest,
    ...(onboardingResult ? { onboarding: onboardingResult } : {}),
  };
}

async function dryRunOnboarding(
  rawConfig: unknown,
  options: CreateOptions,
  manifest: ManifestData,
): Promise<{ onboarding?: EngineResult; onboardingNote?: string }> {
  if (manifestIsEmpty(manifest)) {
    return { onboardingNote: "onboarding will be applied after the resources are created" };
  }
  try {
    const result = await runEngine(rawConfig, {
      port: options.port,
      manifest,
      guildId: options.guildId,
      dryRun: true,
      ...(options.journal ? { journal: options.journal } : {}),
      ...(options.reasonSuffix ? { reasonSuffix: options.reasonSuffix } : {}),
    });
    return { onboarding: result };
  } catch (error) {
    if (error instanceof MissingBindingsError) {
      return {
        onboardingNote:
          "onboarding bindings not resolvable yet (resources not created in this dry-run)",
      };
    }
    throw error;
  }
}

interface TempVisibilityPatch {
  channelId: string;
  originalOverwrites: ApiPermissionOverwrite[] | null | undefined;
}

async function ensureDefaultChannelsVisibleForOnboarding(
  semantic: SemanticResult,
  manifest: ManifestData,
  options: CreateOptions,
): Promise<TempVisibilityPatch[]> {
  const defaultChannels = semantic.onboarding.defaultChannels ?? [];
  if (defaultChannels.length === 0) return [];
  const defaultIds = defaultChannels
    .map((authored) => {
      const key = authored.startsWith("ref:")
        ? authored.slice("ref:".length)
        : `channels.${authored}`;
      return manifest.bindings[key]?.discordId;
    })
    .filter((id): id is string => Boolean(id));
  if (defaultIds.length === 0) return [];
  const [channels, roles] = await Promise.all([
    options.port.listChannels(options.guildId),
    options.port.listRoles(options.guildId),
  ]);
  const channelById = new Map(channels.map((ch) => [ch.id, ch]));
  const everyone = roles.find((r) => r.id === options.guildId);
  const base = everyone ? BigInt(everyone.permissions) : 0n;
  const VIEW = 1024n;
  const SEND = 2048n;
  const patches: TempVisibilityPatch[] = [];
  const reason = `Chrysalis: onboarding default visibility fix${options.reasonSuffix ? ` ${options.reasonSuffix}` : ""}`;
  for (const id of defaultIds) {
    const live = channelById.get(id);
    if (!live) continue;
    const overwrites = live.permission_overwrites ?? [];
    const everyoneOverwrite = overwrites.find((o) => o.type === 0 && o.id === options.guildId);
    const allow = everyoneOverwrite ? BigInt(everyoneOverwrite.allow) : 0n;
    const deny = everyoneOverwrite ? BigInt(everyoneOverwrite.deny) : 0n;
    const effective = (base | allow) & ~deny;
    const canView = (effective & VIEW) !== 0n;
    const canSend = (effective & SEND) !== 0n;
    if (!canView || !canSend) {
      const original = live.permission_overwrites ? [...live.permission_overwrites] : null;
      // Make visible+sendable: ensure allow has VIEW+SEND and deny has neither
      const newAllow = (allow | VIEW | SEND).toString();
      const newDeny = (deny & ~(VIEW | SEND)).toString();
      const newOverwrites: ApiPermissionOverwrite[] = overwrites.map((o) =>
        o.type === 0 && o.id === options.guildId ? { ...o, allow: newAllow, deny: newDeny } : o,
      );
      if (!everyoneOverwrite) {
        newOverwrites.push({ id: options.guildId, type: 0, allow: newAllow, deny: "0" });
      }
      await options.port.updateChannel(
        options.guildId,
        id,
        { permission_overwrites: newOverwrites },
        reason,
      );
      patches.push({ channelId: id, originalOverwrites: original });
      await options.journal?.append({
        op: "onboarding.defaultChannelVisibilityFix",
        intent: "before",
        status: "done",
        detail: id,
      });
    }
  }
  return patches;
}

async function restoreDefaultChannelsVisibility(
  patches: TempVisibilityPatch[],
  options: CreateOptions,
): Promise<void> {
  if (patches.length === 0) return;
  const reason = `Chrysalis: restore onboarding default visibility${options.reasonSuffix ? ` ${options.reasonSuffix}` : ""}`;
  for (const patch of patches) {
    try {
      await options.port.updateChannel(
        options.guildId,
        patch.channelId,
        { permission_overwrites: patch.originalOverwrites ?? [] },
        reason,
      );
      await options.journal?.append({
        op: "onboarding.defaultChannelVisibilityFix",
        intent: "after",
        status: "done",
        detail: patch.channelId,
      });
    } catch {
      // Best-effort revert; leave target with temporarily visible defaults if revert fails
    }
  }
}

function manifestIsEmpty(manifest: ManifestData): boolean {
  return Object.keys(manifest.bindings).length === 0;
}

// --- plan building ---

interface SpecData {
  guild?: ValidatedGuildSettings;
  roles?: ValidatedRoles;
  channels?: ValidatedChannels;
}

interface LiveData {
  guild: ApiGuild;
  roles: ApiRole[];
  channels: ApiChannel[];
}

interface RecoveryDescriptor {
  fingerprint: string;
  resourceName: string;
  resourceType?: number | undefined;
}

/**
 * Resolve all durable pending creates before a new plan is built.
 *
 * A pending create is deliberately fail-closed: zero candidates is not proof
 * that the previous POST was never accepted, so this function never emits a
 * second POST for that logical key. Dry-runs operate on a cloned manifest and
 * therefore never persist a recovery binding.
 */
async function recoverPendingCreates(
  semantic: SemanticResult,
  live: LiveData,
  loadedManifest: ManifestData,
  options: CreateOptions,
): Promise<ManifestData> {
  const pendingCreates = loadedManifest.pendingCreates ?? [];
  if (pendingCreates.length === 0) return loadedManifest;

  const manifest = cloneManifest(loadedManifest);
  const recovered: PendingCreate[] = [];
  for (const pending of pendingCreates) {
    const descriptor = buildRecoveryDescriptor(pending, semantic, live.guild.id, manifest);
    if (descriptor.fingerprint !== pending.fingerprint) {
      throw new PendingCreateRecoveryError(
        pending.logicalKey,
        [],
        "the desired configuration changed since the request was prepared",
      );
    }

    const candidates = findRecoveryCandidates(pending, descriptor, live);
    if (candidates.length !== 1) {
      const detail =
        candidates.length === 0
          ? "no exact live candidate was found; retrying could duplicate the remote resource"
          : `found ${candidates.length} exact live candidates (${candidates.map((candidate) => candidate.id).join(", ")})`;
      if (!options.dryRun) {
        await options.journal?.append({
          op: `${pending.kind}.create.ambiguous`,
          intent: "after",
          status: "failed",
          detail: `${pending.operationId}: ${detail}`,
        });
      }
      throw new PendingCreateRecoveryError(pending.logicalKey, candidates, detail);
    }

    const candidate = candidates[0];
    if (!candidate) {
      throw new PendingCreateRecoveryError(
        pending.logicalKey,
        [],
        "the recovery candidate disappeared during discovery",
      );
    }
    const conflict = Object.entries(manifest.bindings).find(
      ([logicalKey, binding]) =>
        binding.discordId === candidate.id && logicalKey !== pending.logicalKey,
    );
    if (conflict) {
      throw new PendingCreateRecoveryError(
        pending.logicalKey,
        candidates,
        `candidate ${candidate.id} is already bound to ${conflict[0]}`,
      );
    }

    manifest.bindings[pending.logicalKey] = makeBinding(pending.key, pending.kind, candidate.id);
    removePendingCreate(manifest, pending.operationId);
    recovered.push(pending);
  }

  if (!options.dryRun) {
    await options.manifestStore.save(manifest);
    for (const pending of recovered) {
      await options.journal?.append({
        op: `${pending.kind}.create.recovered`,
        intent: "after",
        status: "done",
        detail: pending.operationId,
      });
    }
  }
  return manifest;
}

function buildRecoveryDescriptor(
  pending: PendingCreate,
  semantic: SemanticResult,
  guildId: string,
  manifest: ManifestData,
): RecoveryDescriptor {
  if (pending.kind === "role") {
    const role = semantic.roles?.roles.find((candidate) => candidate.key === pending.key);
    if (!role) {
      throw new PendingCreateRecoveryError(
        pending.logicalKey,
        [],
        "the logical role is no longer declared in the configuration",
      );
    }
    const body = roleCreateBody(role);
    return {
      fingerprint: roleFingerprintFromBody(body),
      resourceName: body.name,
    };
  }

  const channel = findChannelConfig(semantic.channels, pending.key);
  if (!channel) {
    throw new PendingCreateRecoveryError(
      pending.logicalKey,
      [],
      "the logical channel is no longer declared in the configuration",
    );
  }
  const payload = channelCreatePayload(channel);
  const body = resolveChannelCreate(payload, manifest, guildId);
  return {
    fingerprint: channelFingerprintFromBody(body),
    resourceName: body.name,
    resourceType: body.type,
  };
}

function findRecoveryCandidates(
  pending: PendingCreate,
  descriptor: RecoveryDescriptor,
  live: LiveData,
): PendingRecoveryCandidate[] {
  if (pending.kind === "role") {
    return live.roles
      .filter(
        (role) => role.managed !== true && roleFingerprintFromLive(role) === descriptor.fingerprint,
      )
      .map((role) => ({ id: role.id, name: role.name }));
  }
  return live.channels
    .filter((channel) => channelFingerprintFromLive(channel) === descriptor.fingerprint)
    .map((channel) => ({ id: channel.id, name: channel.name }));
}

function findChannelConfig(
  channels: ValidatedChannels | undefined,
  key: string,
): ValidatedChannel | undefined {
  return [...(channels?.categories ?? []), ...(channels?.channels ?? [])].find(
    (channel) => channel.key === key,
  );
}

function cloneManifest(manifest: ManifestData): ManifestData {
  const bindings: Record<string, Binding> = {};
  for (const [logicalKey, binding] of Object.entries(manifest.bindings)) {
    bindings[logicalKey] = { ...binding, aliases: [...binding.aliases] };
  }
  return {
    meta: { ...manifest.meta },
    bindings,
    ...(manifest.pendingCreates
      ? {
          pendingCreates: manifest.pendingCreates.map((pending) => ({
            ...pending,
          })),
        }
      : {}),
  };
}

function buildCreatePlan(spec: SpecData, live: LiveData, manifest: ManifestData): CreatePlan {
  const ops: CreateOp[] = [];
  const warnings: string[] = [];

  // Guild base settings first (no dependencies).
  ops.push(...buildGuildBaseOps(spec.guild, live.guild));

  const roles = buildRoleOps(spec.roles, live, manifest);
  ops.push(...roles.ops);

  // Channels first, then COMMUNITY, then announcement channels. Discord only
  // accepts creating GUILD_ANNOUNCEMENT (type 5) channels on a COMMUNITY guild,
  // so the enable-community op must run before the announcement creates.
  const channels = buildChannelOps(spec.channels, live, manifest, warnings);
  ops.push(...channels.ops);

  ops.push(...buildCommunityOps(spec.guild, live.guild, manifest));

  ops.push(...channels.announcementOps);

  return {
    ops,
    untrackedRoles: roles.untracked,
    untrackedChannels: channels.untracked,
    warnings: [...warnings, ...channels.warnings],
    deferredChannelOrdering: channels.deferredChannelOrdering,
    deferredRoleOrdering: roles.deferredRoleOrdering,
  };
}

function buildGuildBaseOps(
  desired: ValidatedGuildSettings | undefined,
  live: ApiGuild,
): CreateOp[] {
  if (!desired) return [];
  const patch: GuildPatchBody = {};
  if (desired.name !== undefined && live.name !== desired.name) patch.name = desired.name;
  if (
    desired.verificationLevel !== undefined &&
    live.verification_level !== desired.verificationLevel
  ) {
    patch.verification_level = desired.verificationLevel;
  }
  if (
    desired.explicitContentFilter !== undefined &&
    live.explicit_content_filter !== desired.explicitContentFilter
  ) {
    patch.explicit_content_filter = desired.explicitContentFilter;
  }
  if (
    desired.defaultMessageNotifications !== undefined &&
    live.default_message_notifications !== desired.defaultMessageNotifications
  ) {
    patch.default_message_notifications = desired.defaultMessageNotifications;
  }
  if (desired.preferredLocale !== undefined && live.preferred_locale !== desired.preferredLocale) {
    patch.preferred_locale = desired.preferredLocale;
  }
  return Object.keys(patch).length > 0 ? [{ op: "patch-guild" as const, patch }] : [];
}

function buildCommunityOps(
  desired: ValidatedGuildSettings | undefined,
  live: ApiGuild,
  manifest: ManifestData,
): CreateOp[] {
  const community = desired?.community;
  if (!community?.rulesChannel || !community.publicUpdatesChannel) return [];

  if (!live.features.includes("COMMUNITY")) {
    return [
      {
        op: "enable-community",
        rulesChannelRef: community.rulesChannel,
        publicUpdatesChannelRef: community.publicUpdatesChannel,
      },
    ];
  }

  const patch: GuildPatchBody = {};
  const rulesId = resolveRef(manifest, community.rulesChannel, "channels");
  const updatesId = resolveRef(manifest, community.publicUpdatesChannel, "channels");
  if (rulesId && live.rules_channel_id !== rulesId) patch.rules_channel_id = rulesId;
  if (updatesId && live.public_updates_channel_id !== updatesId) {
    patch.public_updates_channel_id = updatesId;
  }
  return Object.keys(patch).length > 0 ? [{ op: "patch-guild" as const, patch }] : [];
}

function buildRoleOps(
  spec: ValidatedRoles | undefined,
  live: LiveData,
  manifest: ManifestData,
): { ops: CreateOp[]; untracked: string[]; deferredRoleOrdering: boolean } {
  const ops: CreateOp[] = [];
  const roleConfigs = spec?.roles ?? [];
  const roleOrder = spec?.ordering ?? roleConfigs.map((role) => role.key);
  const liveById = new Map(live.roles.map((role) => [role.id, role]));
  const boundIds = new Set(
    Object.values(manifest.bindings)
      .filter((binding) => binding.kind === "role")
      .map((binding) => binding.discordId),
  );

  for (const key of roleOrder) {
    const roleConfig = roleConfigs.find((role) => role.key === key);
    if (!roleConfig) continue;
    const binding = manifest.bindings[`roles.${key}`];
    const liveRole = binding ? liveById.get(binding.discordId) : undefined;
    if (!binding || !liveRole) {
      ops.push({ op: "create-role", key, body: roleCreateBody(roleConfig) });
    } else {
      const patch = roleDiff(roleConfig, liveRole);
      if (patch) ops.push({ op: "update-role", key, discordId: liveRole.id, patch });
    }
  }

  // Positions (top-first): compare the managed live order against the desired
  // order. Only when the spec actually declares roles — a spec without a
  // `roles` section must never touch role positions (e.g. onboarding-only
  // source syncs). Defer when a bound role is missing from the live guild
  // (recreated this run): the position settle runs post-execute, mirroring the
  // channel ordering deferral.
  const positionPlan = buildRolePositionPlan(spec, live.roles, manifest);

  const untracked = live.roles
    .filter((role) => role.id !== live.guild.id && !boundIds.has(role.id))
    .map((role) => role.name);
  return { ops, untracked, deferredRoleOrdering: positionPlan.deferred };
}

interface RolePositionPlan {
  op?: Extract<CreateOp, { op: "reorder-roles" }> | undefined;
  deferred: boolean;
}

/**
 * Desired role order (top-first): position = length - index so the first entry
 * sits at the top. Deferred when any desired role id is not yet live (it is
 * being created this run) — the caller re-runs this after creates bind.
 */
function buildRolePositionPlan(
  spec: ValidatedRoles | undefined,
  liveRoles: ApiRole[],
  manifest: ManifestData,
): RolePositionPlan {
  const roleConfigs = spec?.roles ?? [];
  const roleOrder = spec?.ordering ?? roleConfigs.map((role) => role.key);
  const liveById = new Map(liveRoles.map((role) => [role.id, role]));
  const boundIds = new Set(
    Object.values(manifest.bindings)
      .filter((binding) => binding.kind === "role")
      .map((binding) => binding.discordId),
  );

  const managedLive = liveRoles
    .filter((role) => boundIds.has(role.id))
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  const desiredSeq = roleOrder
    .map((key) => manifest.bindings[`roles.${key}`]?.discordId)
    .filter((id): id is string => Boolean(id));
  // A bound role missing from the live guild gets recreated this run; defer
  // position settling until it exists again. Also defer when not every desired
  // role has a binding yet (fresh target: all roles are created this run and
  // their snowflakes are unknown at plan time).
  const missingLive = desiredSeq.some((id) => !liveById.has(id));
  const allBound = desiredSeq.length === roleOrder.length;
  if (roleOrder.length > 0 && !missingLive && allBound) {
    const liveSeq = managedLive.map((role) => role.id);
    if (!sameSeq(desiredSeq, liveSeq)) {
      return {
        op: {
          op: "reorder-roles",
          entries: desiredSeq.map((id, index) => ({ id, position: desiredSeq.length - index })),
        },
        deferred: false,
      };
    }
  }
  return { deferred: roleOrder.length > 0 && (missingLive || !allBound) };
}

function buildChannelOps(
  spec: ValidatedChannels | undefined,
  live: LiveData,
  manifest: ManifestData,
  warnings: string[],
): {
  ops: CreateOp[];
  /** create-channel ops for GUILD_ANNOUNCEMENT (type 5) channels. Discord only
   *  accepts creating announcement channels on a COMMUNITY guild, so these are
   *  emitted AFTER the enable-community op (see buildCreatePlan). */
  announcementOps: CreateOp[];
  untracked: string[];
  warnings: string[];
  deferredChannelOrdering: boolean;
} {
  const ops: CreateOp[] = [];
  const announcementOps: CreateOp[] = [];
  const categories = spec?.categories ?? [];
  const children = spec?.channels ?? [];
  const all = [...categories, ...children];
  const liveById = new Map(live.channels.map((channel) => [channel.id, channel]));
  const boundIds = new Set(
    Object.values(manifest.bindings)
      .filter((binding) => binding.kind === "channel")
      .map((binding) => binding.discordId),
  );

  for (const channelConfig of all) {
    const binding = manifest.bindings[`channels.${channelConfig.key}`];
    const liveChannel = binding ? liveById.get(binding.discordId) : undefined;
    if (!binding || !liveChannel) {
      const createOp: CreateOp = {
        op: "create-channel",
        key: channelConfig.key,
        payload: channelCreatePayload(channelConfig),
      };
      if (channelConfig.type === 5) {
        announcementOps.push(createOp);
      } else {
        ops.push(createOp);
      }
    } else {
      const patch = channelDiff(channelConfig, liveChannel, manifest, warnings, live.guild.id);
      if (patch)
        ops.push({
          op: "update-channel",
          key: channelConfig.key,
          discordId: liveChannel.id,
          patch,
        });
    }
  }

  const positionPlan = buildChannelPositionPlan(spec, live.channels, manifest, warnings);
  if (positionPlan.op) ops.push(positionPlan.op);

  const untracked = live.channels
    .filter((channel) => !boundIds.has(channel.id))
    .map((channel) => channel.name);
  return {
    ops,
    announcementOps,
    untracked,
    warnings,
    deferredChannelOrdering: positionPlan.deferred,
  };
}

interface ChannelPositionPlan {
  op?: Extract<CreateOp, { op: "reorder-channels" }> | undefined;
  deferred: boolean;
}

function buildChannelPositionPlan(
  spec: ValidatedChannels | undefined,
  liveChannels: ApiChannel[],
  manifest: ManifestData,
  warnings?: string[],
): ChannelPositionPlan {
  const groups = buildChannelGroups(spec);
  const liveById = new Map(liveChannels.map((channel) => [channel.id, channel]));
  const entries: ChannelPositionEntry[] = [];
  let positionsDiffer = false;
  let deferred = false;

  for (const [parentKey, desiredKeys] of groups) {
    const parentId = parentKey ? manifest.bindings[`channels.${parentKey}`]?.discordId : undefined;
    if (parentKey && !parentId) {
      deferred = true;
      warnings?.push(`parent of group "${parentKey}" is unbound — channel ordering deferred`);
      continue;
    }
    const desiredSeq = desiredKeys
      .map((key) => manifest.bindings[`channels.${key}`]?.discordId)
      .filter((id): id is string => Boolean(id));
    if (desiredSeq.length !== desiredKeys.length) {
      deferred = true;
      continue;
    }

    const desiredIds = new Set(desiredSeq);
    const liveGroup = liveChannels
      .filter((channel) => {
        const sameParent =
          parentId === undefined
            ? channel.parent_id === null || channel.parent_id === undefined
            : channel.parent_id === parentId;
        return sameParent && desiredIds.has(channel.id);
      })
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    if (desiredSeq.some((id) => !liveById.has(id))) {
      deferred = true;
      continue;
    }
    const liveSeq = liveGroup.map((channel) => channel.id);
    if (!sameSeq(desiredSeq, liveSeq)) {
      positionsDiffer = true;
      desiredSeq.forEach((id, index) => {
        entries.push({ id, position: index });
      });
    }
  }

  return {
    ...(positionsDiffer ? { op: { op: "reorder-channels", entries } } : {}),
    deferred,
  };
}

/**
 * Build the desired order per parent group. `""` is the top-level group
 * (categories + parentless channels). When present, `channels.ordering` is a
 * flat DFS sequence and is the source of truth; declaration order is only the
 * backwards-compatible fallback when ordering is omitted.
 */
function buildChannelGroups(spec: ValidatedChannels | undefined): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const categories = spec?.categories ?? [];
  const children = spec?.channels ?? [];
  const all = [...categories, ...children];
  const byKey = new Map(all.map((channel) => [channel.key, channel]));
  const fallback = [
    ...categories.map((category) => category.key),
    ...children.map((child) => child.key),
  ];
  const orderedKeys = spec?.ordering ?? fallback;

  groups.set("", []);
  for (const key of orderedKeys) {
    const channel = byKey.get(key);
    if (!channel) continue;
    const parentKey =
      channel.parent === undefined
        ? ""
        : refToLogicalKey(channel.parent, "channels").slice("channels.".length);
    const group = groups.get(parentKey) ?? [];
    group.push(key);
    groups.set(parentKey, group);
  }
  return groups;
}

// --- payload builders & drift diffs ---

function roleCreateBody(role: ValidatedRole): RoleCreateBody {
  const body: RoleCreateBody = { name: role.name };
  if (role.permissions !== undefined) body.permissions = role.permissions;
  if (role.color !== undefined) body.color = role.color;
  if (role.hoist !== undefined) body.hoist = role.hoist;
  if (role.mentionable !== undefined) body.mentionable = role.mentionable;
  if (role.icon !== undefined) body.icon = role.icon;
  if (role.unicodeEmoji !== undefined) body.unicode_emoji = role.unicodeEmoji;
  return body;
}

function roleDiff(role: ValidatedRole, live: ApiRole): RolePatchBody | undefined {
  const patch: RolePatchBody = {};
  if (role.name !== live.name) patch.name = role.name;
  if ((role.color ?? 0) !== (live.color ?? 0)) patch.color = role.color ?? 0;
  if ((role.hoist ?? false) !== (live.hoist ?? false)) patch.hoist = role.hoist ?? false;
  if ((role.mentionable ?? false) !== (live.mentionable ?? false)) {
    patch.mentionable = role.mentionable ?? false;
  }
  if (role.permissions !== undefined && role.permissions !== live.permissions) {
    patch.permissions = role.permissions;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function channelCreatePayload(channel: ValidatedChannel): ChannelCreatePayload {
  const payload: ChannelCreatePayload = { name: channel.name, type: channel.type };
  if (channel.topic !== undefined) payload.topic = channel.topic;
  if (channel.nsfw !== undefined) payload.nsfw = channel.nsfw;
  if (channel.rateLimitPerUser !== undefined) payload.rateLimitPerUser = channel.rateLimitPerUser;
  if (channel.bitrate !== undefined) payload.bitrate = channel.bitrate;
  if (channel.userLimit !== undefined) payload.userLimit = channel.userLimit;
  if (channel.videoQualityMode !== undefined) payload.videoQualityMode = channel.videoQualityMode;
  if (channel.defaultAutoArchiveDuration !== undefined) {
    payload.defaultAutoArchiveDuration = channel.defaultAutoArchiveDuration;
  }
  if (channel.availableTags !== undefined && channel.availableTags.length > 0) {
    payload.availableTags = channel.availableTags;
  }
  if (channel.parent !== undefined) payload.parentRef = channel.parent;
  if (channel.overwrites !== undefined && channel.overwrites.length > 0) {
    payload.overwrites = channel.overwrites;
  }
  return payload;
}

function roleFingerprintFromBody(body: RoleCreateBody): string {
  return JSON.stringify({
    kind: "role",
    name: body.name,
    permissions: body.permissions ?? "0",
    color: body.color ?? 0,
    hoist: body.hoist ?? false,
    mentionable: body.mentionable ?? false,
    icon: body.icon ?? null,
    unicode_emoji: body.unicode_emoji ?? null,
  });
}

function roleFingerprintFromLive(role: ApiRole): string {
  return JSON.stringify({
    kind: "role",
    name: role.name,
    permissions: role.permissions,
    color: role.color ?? 0,
    hoist: role.hoist ?? false,
    mentionable: role.mentionable ?? false,
    icon: role.icon ?? null,
    unicode_emoji: role.unicode_emoji ?? null,
  });
}

interface FingerprintTag {
  name: string;
  emoji_id: string | null;
  emoji_name: string | null;
  moderated: boolean;
}

interface FingerprintOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

function channelFingerprintFromBody(body: ChannelCreateBody): string {
  return JSON.stringify({
    kind: "channel",
    name: body.name,
    type: body.type ?? 0,
    parent_id: body.parent_id ?? null,
    topic: body.topic ?? "",
    nsfw: body.nsfw ?? false,
    rate_limit_per_user: body.rate_limit_per_user ?? 0,
    bitrate: body.bitrate ?? null,
    user_limit: body.user_limit ?? null,
    video_quality_mode: body.video_quality_mode ?? null,
    default_auto_archive_duration: body.default_auto_archive_duration ?? null,
    available_tags: normalizeBodyTags(body.available_tags),
    permission_overwrites: normalizeOverwrites(body.permission_overwrites),
  });
}

function channelFingerprintFromLive(channel: ApiChannel): string {
  return JSON.stringify({
    kind: "channel",
    name: channel.name,
    type: channel.type,
    parent_id: channel.parent_id ?? null,
    topic: channel.topic ?? "",
    nsfw: channel.nsfw ?? false,
    rate_limit_per_user: channel.rate_limit_per_user ?? 0,
    bitrate: channel.bitrate ?? null,
    user_limit: channel.user_limit ?? null,
    video_quality_mode: channel.video_quality_mode ?? null,
    default_auto_archive_duration: channel.default_auto_archive_duration ?? null,
    available_tags: normalizeLiveTags(channel.available_tags),
    permission_overwrites: normalizeOverwrites(channel.permission_overwrites),
  });
}

function normalizeBodyTags(tags: ChannelTagBody[] | undefined): FingerprintTag[] {
  return (tags ?? []).map((tag) => ({
    name: tag.name,
    emoji_id: tag.emoji_id ?? null,
    emoji_name: tag.emoji_name ?? null,
    moderated: tag.moderated ?? false,
  }));
}

function normalizeLiveTags(tags: ApiChannel["available_tags"]): FingerprintTag[] {
  return (tags ?? []).map((tag) => ({
    name: tag.name,
    emoji_id: tag.emoji_id ?? null,
    emoji_name: tag.emoji_name ?? null,
    moderated: tag.moderated ?? false,
  }));
}

function normalizeOverwrites(
  overwrites: ApiPermissionOverwrite[] | null | undefined,
): FingerprintOverwrite[] {
  return [...(overwrites ?? [])]
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow,
      deny: overwrite.deny,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function channelDiff(
  channel: ValidatedChannel,
  live: ApiChannel,
  manifest: ManifestData,
  warnings: string[],
  guildId: string,
): ChannelPatchBody | undefined {
  const patch: ChannelPatchBody = {};
  if (channel.name !== live.name) patch.name = channel.name;
  const desiredTopic = channel.topic ?? "";
  const liveTopic = live.topic ?? "";
  if (desiredTopic !== liveTopic) patch.topic = desiredTopic;
  if ((channel.nsfw ?? false) !== (live.nsfw ?? false)) patch.nsfw = channel.nsfw ?? false;
  if ((channel.rateLimitPerUser ?? 0) !== (live.rate_limit_per_user ?? 0)) {
    patch.rate_limit_per_user = channel.rateLimitPerUser ?? 0;
  }
  if (channel.bitrate !== undefined && channel.bitrate !== live.bitrate) {
    patch.bitrate = channel.bitrate;
  }
  if (channel.userLimit !== undefined && channel.userLimit !== live.user_limit) {
    patch.user_limit = channel.userLimit;
  }
  if (
    channel.videoQualityMode !== undefined &&
    channel.videoQualityMode !== live.video_quality_mode
  ) {
    patch.video_quality_mode = channel.videoQualityMode;
  }
  if (
    channel.defaultAutoArchiveDuration !== undefined &&
    channel.defaultAutoArchiveDuration !== live.default_auto_archive_duration
  ) {
    patch.default_auto_archive_duration = channel.defaultAutoArchiveDuration;
  }

  if (channel.parent !== undefined) {
    const desiredParentId = resolveRef(manifest, channel.parent, "channels");
    const liveParentId = live.parent_id ?? undefined;
    if (desiredParentId !== undefined && desiredParentId !== liveParentId) {
      patch.parent_id = desiredParentId;
    } else if (desiredParentId === undefined) {
      warnings.push(`parent of "${channel.key}" is unbound — parent drift not checked`);
    }
  }

  const overwrites = resolveOverwrites(channel.overwrites ?? [], manifest, guildId);
  if (overwrites.resolved) {
    if (normOverwrites(overwrites.resolved) !== normOverwrites(live.permission_overwrites ?? [])) {
      patch.permission_overwrites = overwrites.resolved;
    }
  } else {
    warnings.push(
      `overwrite refs unbound for "${channel.key}" (${overwrites.missing.join(", ")}) — overwrite drift not checked`,
    );
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

// --- execution ---

async function executeOps(
  ops: CreateOp[],
  options: CreateOptions,
  initialManifest: ManifestData,
): Promise<ManifestData> {
  const manifest = initialManifest;
  const reason = `Chrysalis: server create${options.reasonSuffix ? ` ${options.reasonSuffix}` : ""}`;

  for (const op of ops) {
    const label = describeOp(op);
    await options.journal?.append({
      op: label,
      intent: "before",
      status: "pending",
      detail: opDetail(op),
    });
    try {
      switch (op.op) {
        case "create-role": {
          const pending = makePendingCreate(
            op.key,
            "role",
            roleFingerprintFromBody(op.body),
            op.body.name,
          );
          await beginPendingCreate(manifest, pending, options.manifestStore);
          await options.journal?.append({
            op: "role.create.sent",
            intent: "before",
            status: "pending",
            detail: pending.operationId,
          });
          const role = await options.port.createRole(options.guildId, op.body, reason);
          await commitCreatedBinding(
            manifest,
            pending,
            makeBinding(op.key, "role", role.id),
            options.manifestStore,
          );
          await options.journal?.append({
            op: "role.create.committed",
            intent: "after",
            status: "done",
            detail: pending.operationId,
          });
          break;
        }
        case "update-role":
          await options.port.updateRole(options.guildId, op.discordId, op.patch, reason);
          break;
        case "reorder-roles":
          await options.port.updateRolePositions(options.guildId, op.entries, reason);
          break;
        case "create-channel": {
          const body = resolveChannelCreate(op.payload, manifest, options.guildId);
          const pending = makePendingCreate(
            op.key,
            "channel",
            channelFingerprintFromBody(body),
            body.name,
            body.type,
          );
          await beginPendingCreate(manifest, pending, options.manifestStore);
          await options.journal?.append({
            op: "channel.create.sent",
            intent: "before",
            status: "pending",
            detail: pending.operationId,
          });
          const channel = await options.port.createChannel(options.guildId, body, reason);
          await commitCreatedBinding(
            manifest,
            pending,
            makeBinding(op.key, "channel", channel.id),
            options.manifestStore,
          );
          await options.journal?.append({
            op: "channel.create.committed",
            intent: "after",
            status: "done",
            detail: pending.operationId,
          });
          break;
        }
        case "update-channel":
          await options.port.updateChannel(options.guildId, op.discordId, op.patch, reason);
          break;
        case "reorder-channels":
          await options.port.updateChannelPositions(options.guildId, op.entries, reason);
          break;
        case "patch-guild":
          await options.port.updateGuild(options.guildId, op.patch, reason);
          break;
        case "enable-community": {
          const rulesId = resolveRef(manifest, op.rulesChannelRef, "channels");
          const updatesId = resolveRef(manifest, op.publicUpdatesChannelRef, "channels");
          if (!rulesId || !updatesId) {
            throw new CreateError(
              "community-channels-unbound",
              `cannot enable COMMUNITY: rules/public-updates channel refs unbound ` +
                `(rules=${op.rulesChannelRef} publicUpdates=${op.publicUpdatesChannelRef})`,
            );
          }
          // Discord requires rules_channel_id + public_updates_channel_id to
          // ride in the SAME request as features: [..., "COMMUNITY"], and there
          // is an undocumented prerequisite: explicit_content_filter must be 2
          // (all members) and verification_level >= 1. Apply the prereqs first
          // (only when the live guild still misses them), then the combined
          // channels+feature PATCH preserving the guild's existing features.
          const currentGuild = await options.port.getGuild(options.guildId);
          const currentFilter = currentGuild.explicit_content_filter ?? 0;
          const currentVerification = currentGuild.verification_level ?? 0;
          if (currentFilter < 2 || currentVerification < 1) {
            await options.port.updateGuild(
              options.guildId,
              {
                verification_level: Math.max(currentVerification, 1),
                explicit_content_filter: Math.max(currentFilter, 2),
              },
              reason,
            );
          }
          await options.port.updateGuild(
            options.guildId,
            {
              features: currentGuild.features.includes("COMMUNITY")
                ? currentGuild.features
                : [...currentGuild.features, "COMMUNITY"],
              rules_channel_id: rulesId,
              public_updates_channel_id: updatesId,
            },
            reason,
          );
          break;
        }
      }
      await options.journal?.append({ op: label, intent: "after", status: "done" });
    } catch (error) {
      const pendingOperationId = createOperationId(op);
      if (pendingOperationId) {
        markPendingCreateUnknown(manifest, pendingOperationId, (error as Error).message);
        await options.manifestStore.save(manifest).catch(() => undefined);
        await options.journal?.append({
          op: `${label}.unknown`,
          intent: "after",
          status: "failed",
          detail: pendingOperationId,
        });
      }
      await options.journal?.append({
        op: label,
        intent: "after",
        status: "failed",
        detail: (error as Error).message,
      });
      if (error instanceof CreateError) throw error;
      throw new CreateError("discord-api", (error as Error).message);
    }
  }
  return manifest;
}

function makePendingCreate(
  key: string,
  kind: "role" | "channel",
  fingerprint: string,
  resourceName: string,
  resourceType?: number,
): PendingCreate {
  return {
    operationId: `${kind === "role" ? "roles" : "channels"}.${key}:create`,
    kind,
    key,
    logicalKey: `${kind === "role" ? "roles" : "channels"}.${key}`,
    fingerprint,
    resourceName,
    ...(resourceType !== undefined ? { resourceType } : {}),
    createdAt: new Date().toISOString(),
    status: "prepared",
  };
}

function createOperationId(op: CreateOp): string | undefined {
  switch (op.op) {
    case "create-role":
      return `roles.${op.key}:create`;
    case "create-channel":
      return `channels.${op.key}:create`;
    default:
      return undefined;
  }
}

async function beginPendingCreate(
  manifest: ManifestData,
  pending: PendingCreate,
  manifestStore: ManifestStore,
): Promise<void> {
  addPendingCreate(manifest, pending);
  try {
    await manifestStore.save(manifest);
  } catch (error) {
    removePendingCreate(manifest, pending.operationId);
    throw new CreateError(
      "manifest-write-before-create",
      `cannot persist pending create for ${pending.logicalKey}; no Discord mutation was attempted: ${(error as Error).message}`,
    );
  }
}

async function commitCreatedBinding(
  manifest: ManifestData,
  pending: PendingCreate,
  binding: Binding,
  manifestStore: ManifestStore,
): Promise<void> {
  const previousBinding = manifest.bindings[pending.logicalKey];
  const previousPending = manifest.pendingCreates?.map((entry) => ({ ...entry }));
  manifest.bindings[pending.logicalKey] = binding;
  removePendingCreate(manifest, pending.operationId);
  try {
    await manifestStore.save(manifest);
  } catch (error) {
    if (previousBinding) {
      manifest.bindings[pending.logicalKey] = previousBinding;
    } else {
      delete manifest.bindings[pending.logicalKey];
    }
    if (previousPending) {
      manifest.pendingCreates = previousPending;
    } else {
      delete manifest.pendingCreates;
    }
    throw error;
  }
}

function resolveChannelCreate(
  payload: ChannelCreatePayload,
  manifest: ManifestData,
  guildId: string,
): ChannelCreateBody {
  const body: ChannelCreateBody = { name: payload.name, type: payload.type };
  if (payload.topic !== undefined) body.topic = payload.topic;
  if (payload.nsfw !== undefined) body.nsfw = payload.nsfw;
  if (payload.rateLimitPerUser !== undefined) body.rate_limit_per_user = payload.rateLimitPerUser;
  if (payload.bitrate !== undefined) body.bitrate = payload.bitrate;
  if (payload.userLimit !== undefined) body.user_limit = payload.userLimit;
  if (payload.videoQualityMode !== undefined) body.video_quality_mode = payload.videoQualityMode;
  if (payload.defaultAutoArchiveDuration !== undefined) {
    body.default_auto_archive_duration = payload.defaultAutoArchiveDuration;
  }
  if (payload.availableTags !== undefined && payload.availableTags.length > 0) {
    body.available_tags = payload.availableTags.map((tag) => ({
      name: tag.name,
      ...(tag.emojiName ? { emoji_name: tag.emojiName } : {}),
      ...(tag.emojiId ? { emoji_id: tag.emojiId } : {}),
      moderated: tag.moderated ?? false,
    }));
  }
  if (payload.parentRef) {
    const parentId = resolveRef(manifest, payload.parentRef, "channels");
    if (!parentId) {
      throw new CreateError(
        "channel-parent-unbound",
        `cannot create channel "${payload.name}": parent ref "${payload.parentRef}" is unbound`,
      );
    }
    body.parent_id = parentId;
  }
  const overwrites = resolveOverwrites(payload.overwrites ?? [], manifest, guildId);
  if (overwrites.missing.length > 0) {
    throw new CreateError(
      "channel-overwrite-unbound",
      `cannot create channel "${payload.name}": overwrite refs are unbound (${overwrites.missing.join(", ")})`,
    );
  }
  if (overwrites.resolved && overwrites.resolved.length > 0) {
    body.permission_overwrites = overwrites.resolved;
  }
  return body;
}

// --- refs & shared helpers ---

function refToLogicalKey(authored: string, kind: "roles" | "channels"): string {
  if (authored.startsWith("ref:")) {
    return authored.slice("ref:".length);
  }
  return `${kind}.${authored}`;
}

function resolveRef(
  manifest: ManifestData,
  authored: string,
  kind: "roles" | "channels",
): string | undefined {
  return manifest.bindings[refToLogicalKey(authored, kind)]?.discordId;
}

function resolveOverwrites(
  overwrites: Array<{ ref: string; allow?: string | undefined; deny?: string | undefined }>,
  manifest: ManifestData,
  guildId: string,
): { resolved?: ApiPermissionOverwrite[]; missing: string[] } {
  const resolved: ApiPermissionOverwrite[] = [];
  const missing: string[] = [];
  for (const overwrite of overwrites) {
    // @everyone is implicit: its snowflake is the guild id in any target guild.
    if (overwrite.ref === EVERYONE_REF) {
      resolved.push({
        id: guildId,
        type: 0,
        allow: overwrite.allow ?? "0",
        deny: overwrite.deny ?? "0",
      });
      continue;
    }
    const id = resolveRef(manifest, overwrite.ref, "roles");
    if (id) {
      resolved.push({
        id,
        type: 0,
        allow: overwrite.allow ?? "0",
        deny: overwrite.deny ?? "0",
      });
    } else {
      missing.push(refToLogicalKey(overwrite.ref, "roles"));
    }
  }
  return { ...(missing.length === 0 ? { resolved } : {}), missing };
}

function normOverwrites(overwrites: ApiPermissionOverwrite[]): string {
  return JSON.stringify([...overwrites].sort((a, b) => a.id.localeCompare(b.id)));
}

function makeBinding(key: string, kind: "role" | "channel", discordId: string): Binding {
  return {
    key,
    aliases: [],
    kind,
    discordId,
    createdAt: new Date().toISOString(),
  };
}

function sameSeq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function describeOp(op: CreateOp): string {
  switch (op.op) {
    case "create-role":
      return "role.create";
    case "update-role":
      return "role.update";
    case "reorder-roles":
      return "role.positions";
    case "create-channel":
      return "channel.create";
    case "update-channel":
      return "channel.update";
    case "reorder-channels":
      return "channel.positions";
    case "patch-guild":
      return "guild.patch";
    case "enable-community":
      return "guild.community";
  }
}

function opDetail(op: CreateOp): string {
  switch (op.op) {
    case "create-role":
    case "create-channel":
    case "update-role":
    case "update-channel":
      return op.key;
    case "reorder-roles":
      return `${op.entries.length} entries`;
    case "reorder-channels":
      return `${op.entries.length} entries`;
    case "patch-guild":
      return Object.keys(op.patch).join(",");
    case "enable-community":
      return `rules=${op.rulesChannelRef} updates=${op.publicUpdatesChannelRef}`;
  }
}
