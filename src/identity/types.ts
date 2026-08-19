/**
 * Identity model (ADR-001): logical key ⇄ Discord snowflake bindings,
 * stored in a git-committed JSON manifest.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export type BindingKind = "role" | "channel";

export interface Binding {
  /** Logical key WITHOUT kind prefix, e.g. "male". */
  key: string;
  /** Historical keys that used to map to this resource (rename survival). */
  aliases: string[];
  kind: BindingKind;
  /** Snowflake assigned once by Discord; never changes. */
  discordId: string;
  createdAt: string;
  lastAppliedAt?: string | undefined;
  lastAppliedHash?: string | undefined;
  /** `true` prevents deletion (Terraform prevent_destroy analog). */
  protect?: boolean;
}

/**
 * Durable intent for a non-idempotent Discord create request.
 *
 * A pending create is intentionally load-bearing: if Discord accepted a POST
 * but the response or the following manifest write was lost, the next run must
 * resolve the outcome instead of issuing a blind second POST.
 */
export interface PendingCreate {
  operationId: string;
  kind: BindingKind;
  key: string;
  logicalKey: string;
  fingerprint: string;
  resourceName: string;
  resourceType?: number | undefined;
  createdAt: string;
  status: "prepared" | "unknown";
  lastError?: string | undefined;
}

export interface ManifestMeta {
  schemaVersion: number;
  guildId?: string | undefined;
  createdAt: string;
  lastPlanHash?: string | undefined;
  deletionPolicy: "never" | "ask" | "allow";
}

export interface ManifestData {
  meta: ManifestMeta;
  /** Logical key (with kind prefix, e.g. "roles.male") → binding. */
  bindings: Record<string, Binding>;
  /** Creates whose remote outcome is not yet durably bound. */
  pendingCreates?: PendingCreate[] | undefined;
}

export interface ManifestInvariants {
  /** schemaVersion supported. */
  schemaVersionSupported: boolean;
  /** Logical keys well-formed and unique. */
  keysValid: boolean;
  /** No two bindings share a discordId. */
  discordIdsUnique: boolean;
}

export interface ManifestValidation {
  ok: boolean;
  invariants: ManifestInvariants;
  errors: string[];
}
