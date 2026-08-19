import { ZodError } from "zod";

import { loadConfig } from "../config/load.js";
import type { SemanticResult } from "../config/semantic.js";
import {
  type CanonicalOnboarding,
  canonicalizeCurrent,
  canonicalizeDesired,
} from "../domain/canonicalize.js";
import { diffOnboarding } from "../domain/diff.js";
import { buildPlan, type PlanOperation } from "../domain/plan.js";
import { type PreflightResult, runPreflight } from "../domain/preflight.js";
import type { Journal } from "../identity/journal.js";
import type { ManifestData } from "../identity/manifest.js";
import type { DiscordPort } from "../port/discord-port.js";
import { discover, resolveDesired } from "./discover-resolve.js";
import { type VerifyResult, verify } from "./verify.js";

/**
 * Engine orchestration (reconciliation.md §2, ADR-003). Lean slice: single kind
 * (onboarding). Phase-gated by the caller (validate stops before Execute).
 */

export interface EngineOptions {
  port: DiscordPort;
  manifest: ManifestData;
  guildId: string;
  /** stop after Plan (no mutations). */
  dryRun: boolean;
  reasonSuffix?: string;
  /** append-only run journal (ADR-001 §4); no journal when omitted. */
  journal?: Journal;
}

export interface EngineResult {
  plan: PlanOperation;
  preflight: PreflightResult;
  verify?: VerifyResult;
  resolvedDesired: CanonicalOnboarding;
}

export class EngineError extends Error {
  public readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.kind = kind;
  }
}

/** Config failed static validation (Zod or semantic) — exit 1, no network. */
export class ConfigError extends EngineError {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super("config", `config invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export class MissingBindingsError extends EngineError {
  public readonly missing: string[];

  constructor(missing: string[]) {
    super(
      "missing-bindings",
      `unbound logical keys (run "chrysalis adopt <kind>.<key> <name>" for each):\n` +
        missing.map((key) => `  - ${key}`).join("\n"),
    );
    this.name = "MissingBindingsError";
    this.missing = missing;
  }
}

export class PreflightError extends EngineError {
  public readonly preflight: PreflightResult;

  constructor(preflight: PreflightResult) {
    super("preflight", `pre-flight checks failed:\n${preflight.errors.join("\n")}`);
    this.name = "PreflightError";
    this.preflight = preflight;
  }
}

/**
 * Full pipeline (phases 1–7, dry-run) or 1–10 (apply). Config errors abort
 * before any network call.
 */
export async function runEngine(rawConfig: unknown, options: EngineOptions): Promise<EngineResult> {
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
  const validated = semantic.onboarding;

  // Phases 3–4: discover + resolve (manifest-strict).
  const discovery = await discover(options.port, options.guildId);
  const { resolved, missing } = resolveDesired(
    validated,
    options.manifest,
    discovery.onboarding.default_channel_ids,
  );
  if (missing.length > 0) {
    throw new MissingBindingsError(missing);
  }

  // Phase 6 pre-flight: live constraints (≥7 / ≥5 SEND_MESSAGES, guild checks).
  const preflight = runPreflight({
    guildId: options.guildId,
    enabled: validated.enabled,
    mode: validated.mode,
    manageDefaultChannels: validated.manageDefaultChannels !== false,
    defaultChannelIds: resolved.defaultChannelIds,
    channels: discovery.channels,
    roles: discovery.roles,
  });
  if (!preflight.ok) {
    throw new PreflightError(preflight);
  }

  // Phases 5–7: diff → plan (→ execute in the caller).
  const desiredCanonical = canonicalizeDesired(resolved);
  const currentCanonical = canonicalizeCurrent(discovery.onboarding);
  const diff = diffOnboarding(desiredCanonical, currentCanonical);
  const plan = buildPlan({
    desired: resolved,
    desiredCanonical,
    current: discovery.onboarding,
    diff: diff.op,
    ...(diff.reason ? { diffReason: diff.reason } : {}),
  });

  let verifyResult: VerifyResult | undefined;
  if (!options.dryRun && plan.op === "UPDATE" && plan.payload) {
    const reason = `Chrysalis: onboarding sync${options.reasonSuffix ? ` ${options.reasonSuffix}` : ""}`;
    await options.journal?.append({
      op: "onboarding.update",
      intent: "before",
      status: "pending",
      detail: plan.id,
    });
    try {
      await options.port.updateOnboarding(options.guildId, plan.payload, reason);
    } catch (error) {
      await options.journal?.append({
        op: "onboarding.update",
        intent: "after",
        status: "failed",
        detail: (error as Error).message,
      });
      throw error;
    }
    await options.journal?.append({
      op: "onboarding.update",
      intent: "after",
      status: "done",
      detail: plan.id,
    });
    verifyResult = await verify(options.port, options.guildId, desiredCanonical);
  }

  return {
    plan,
    preflight,
    ...(verifyResult ? { verify: verifyResult } : {}),
    resolvedDesired: desiredCanonical,
  };
}
