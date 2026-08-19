import { type CanonicalOnboarding, fingerprint } from "./canonicalize.js";

/**
 * Diff for the onboarding kind (reconciliation.md §4/§5).
 *
 * Onboarding is a single aggregate PUT: the diff is document-level.
 * Equal fingerprints ⇒ NOOP. Any difference ⇒ one UPDATE carrying the full
 * desired payload (ids reused from current to avoid churn).
 */

export type OnboardingDiff = "NOOP" | "UPDATE";

export interface DiffResult {
  op: OnboardingDiff;
  /** Human-readable reason when UPDATE (first divergence). */
  reason?: string;
}

export function diffOnboarding(
  desired: CanonicalOnboarding,
  current: CanonicalOnboarding,
): DiffResult {
  if (fingerprint(desired) === fingerprint(current)) {
    return { op: "NOOP" };
  }
  return { op: "UPDATE", reason: firstDivergence(desired, current) };
}

function firstDivergence(desired: CanonicalOnboarding, current: CanonicalOnboarding): string {
  if (desired.enabled !== current.enabled) {
    return `enabled: desired=${desired.enabled} current=${current.enabled}`;
  }
  if (!scalarEq(desired.mode, current.mode)) {
    return `mode differs (desired=${String(desired.mode)} current=${String(current.mode)})`;
  }
  if (diffSets(desired.defaultChannelIds, current.defaultChannelIds)) {
    return "default_channel_ids differ";
  }
  if (desired.prompts.length !== current.prompts.length) {
    return `prompt count: desired=${desired.prompts.length} current=${current.prompts.length}`;
  }
  for (let i = 0; i < desired.prompts.length; i += 1) {
    const dp = desired.prompts[i];
    const cp = current.prompts[i];
    if (dp && cp && !promptEq(dp, cp)) {
      return `prompt[${i}] "${dp.title}" differs`;
    }
  }
  return "unknown divergence";
}

function promptEq(
  a: CanonicalOnboarding["prompts"][number],
  b: CanonicalOnboarding["prompts"][number],
): boolean {
  if (a.title !== b.title || a.type !== b.type) {
    return false;
  }
  if (!scalarEq(a.singleSelect, b.singleSelect)) return false;
  if (!scalarEq(a.required, b.required)) return false;
  if (!scalarEq(a.inOnboarding, b.inOnboarding)) return false;
  if (a.options.length !== b.options.length) return false;
  for (let i = 0; i < a.options.length; i += 1) {
    const ao = a.options[i];
    const bo = b.options[i];
    if (ao && bo && !optionEq(ao, bo)) return false;
  }
  return true;
}

function optionEq(
  a: CanonicalOnboarding["prompts"][number]["options"][number],
  b: CanonicalOnboarding["prompts"][number]["options"][number],
): boolean {
  if (a.title !== b.title) return false;
  if (!scalarEq(a.description, b.description)) return false;
  if (!scalarEq(a.emojiName, b.emojiName)) return false;
  if (!scalarEq(a.emojiAnimated, b.emojiAnimated)) return false;
  if (diffSets(a.roleIds, b.roleIds)) return false;
  if (diffSets(a.channelIds, b.channelIds)) return false;
  return true;
}

function scalarEq(a: unknown, b: unknown): boolean {
  return a === b;
}

function diffSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.some((value, index) => value !== sortedB[index]);
}
