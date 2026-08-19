import { describe, expect, it } from "vitest";
import { DuplicateKeyError, mergeFragments } from "../../src/config/merge.js";
import type { OnboardingConfig, OnboardingPromptConfig } from "../../src/config/types.js";

describe("mergeFragments", () => {
  it("merges a single onboarding fragment", () => {
    const onboarding = {
      enabled: false,
      defaultChannels: ["general"],
      prompts: [],
    } satisfies OnboardingConfig;
    const merged = mergeFragments([{ file: "config/onboarding.ts", value: { onboarding } }]);
    expect(merged.onboarding).toEqual(onboarding);
  });

  it("hard-errors on duplicate onboarding keys with source attribution", () => {
    const base = {
      enabled: false,
      defaultChannels: ["general"],
      prompts: [],
    } satisfies OnboardingConfig;
    const overlay = {
      enabled: true,
      defaultChannels: ["general", "two"],
      prompts: [],
    } satisfies OnboardingConfig;
    expect(() =>
      mergeFragments([
        { file: "config/base.ts", value: { onboarding: base } },
        { file: "config/overlay.ts", value: { onboarding: overlay } },
      ]),
    ).toThrow(DuplicateKeyError);
  });

  it("reports both source files in the duplicate error", () => {
    const base = {
      enabled: false,
      defaultChannels: ["general"],
      prompts: [],
    } satisfies OnboardingConfig;
    const overlay = {
      enabled: true,
      defaultChannels: ["general", "two"],
      prompts: [],
    } satisfies OnboardingConfig;
    try {
      mergeFragments([
        { file: "config/base.ts", value: { onboarding: base } },
        { file: "config/overlay.ts", value: { onboarding: overlay } },
      ]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateKeyError);
      const dup = error as DuplicateKeyError;
      expect(dup.sources).toContain("config/base.ts");
      expect(dup.sources).toContain("config/overlay.ts");
      expect(dup.message).toContain("onboarding.enabled");
    }
  });

  it("splits base fields and prompts across fragments (the per-prompt layout)", () => {
    const base = {
      enabled: true,
      mode: "ONBOARDING_ADVANCED",
      defaultChannels: ["general", "gaming"],
      prompts: [],
    } satisfies OnboardingConfig;
    const genderPrompt = {
      key: "gender",
      title: "Género",
      type: "MULTIPLE_CHOICE",
      options: [{ key: "hombre", title: "Hombre", roles: ["hombre"] }],
    } satisfies OnboardingPromptConfig;
    const countryPrompt = {
      key: "country",
      title: "País",
      type: "DROPDOWN",
      options: [{ key: "argentina", title: "Argentina" }],
    } satisfies OnboardingPromptConfig;
    const merged = mergeFragments([
      { file: "config/onboarding.json", value: { onboarding: base } },
      {
        file: "config/prompt-gender.json",
        value: { onboarding: { prompts: [genderPrompt] } },
      },
      {
        file: "config/prompt-country.json",
        value: { onboarding: { prompts: [countryPrompt] } },
      },
    ]);
    expect(merged.onboarding?.enabled).toBe(true);
    expect(merged.onboarding?.mode).toBe("ONBOARDING_ADVANCED");
    expect(merged.onboarding?.defaultChannels).toEqual(["general", "gaming"]);
    expect(merged.onboarding?.prompts.map((p) => p.key)).toEqual(["gender", "country"]);
  });

  it("errors when two fragments declare the same prompt key", () => {
    const prompt = {
      key: "gender",
      title: "Género",
      type: "MULTIPLE_CHOICE",
      options: [],
    } satisfies OnboardingPromptConfig;
    expect(() =>
      mergeFragments([
        { file: "config/a.json", value: { onboarding: { prompts: [prompt] } } },
        { file: "config/b.json", value: { onboarding: { prompts: [prompt] } } },
      ]),
    ).toThrow(DuplicateKeyError);
  });
});
