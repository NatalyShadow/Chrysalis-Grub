/**
 * Process exit codes (contract from the architecture phase — the exit-codes
 * chapter lives in docs/reconciliation.md §1; error taxonomy in the same doc).
 * Contract: 0 converged · 1 error · 2 changes/partial convergence ·
 * 3 differences + unsafe plan (validate extension) · 70 unexpected.
 * Fixed: do not renumber.
 */

export const ExitCode = {
  /** converged — no change required */
  Converged: 0,
  /** error — config invalid, pre-flight failed, bindings missing, etc. */
  Error: 1,
  /** changes applied (or would apply in dry-run); partial convergence */
  Changes: 2,
  /** differences + unsafe plan (validate extension) */
  UnsafePlan: 3,
  /** unexpected internal error */
  Unexpected: 70,
} as const;
