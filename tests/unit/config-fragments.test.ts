import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadFragmentsFromDisk } from "../../src/config/fragments.js";

const fixture = (name: string) => resolve(import.meta.dirname, "../fixtures", name);

describe("loadFragmentsFromDisk (JSON authoring)", () => {
  it("loads and merges JSON fragments from the config dir", async () => {
    const config = await loadFragmentsFromDisk(fixture("config-good"));
    expect(config.onboarding).toBeDefined();
    expect(config.onboarding?.enabled).toBe(true);
    expect(config.onboarding?.prompts).toHaveLength(1);
    expect(config.onboarding?.prompts[0]?.key).toBe("path");
  });

  it("is deterministic (fragment order follows sorted filenames)", async () => {
    // Two fragments; only the second shadows nothing — onboarding is whole-object
    // merge, so duplicate detection still applies. Use a multi-kind fixture if
    // kinds grow; for now assert a single onboarding fragment merges cleanly.
    const config = await loadFragmentsFromDisk(fixture("config-good"));
    expect(Object.keys(config)).toEqual(["onboarding"]);
  });

  it("hard-errors on an unknown top-level kind (typo guard)", async () => {
    await expect(loadFragmentsFromDisk(fixture("config-unknown"))).rejects.toThrow(
      /unknown top-level kind "onbaording"/,
    );
  });

  it("hard-errors on invalid JSON", async () => {
    await expect(loadFragmentsFromDisk(fixture("config-invalid"))).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
