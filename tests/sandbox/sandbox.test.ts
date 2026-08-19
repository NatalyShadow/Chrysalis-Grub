import { describe, it } from "vitest";

/*
 * Sandbox E2E suite (opt-in, never in CI).
 *
 * Intended job (see tests/sandbox/README.md + docs/roadmap.md Phase 4):
 * resolve the UNVERIFIED items and prove create → converge → sync → NOOP
 * against a throwaway guild on the real REST API.
 *
 * Not written yet — this placeholder is skipped so `pnpm test:sandbox` exits 0.
 * When writing real cases, keep them scoped by the sandbox project include
 * glob (see vitest.config.ts), which only picks tests under tests/sandbox/.
 */
describe.skip("sandbox E2E (throwaway guild)", () => {
  it("placeholder — suite not written yet", () => {
    // Intentionally empty.
  });
});
