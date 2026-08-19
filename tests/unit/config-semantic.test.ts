import { describe, expect, it } from "vitest";
import type {
  ValidatedGuildConfig,
  ValidatedOnboarding,
} from "../../src/config/schema/onboarding.js";
import { runSemanticPass, SemanticErrorException } from "../../src/config/semantic.js";

function buildOnboarding(overrides: Partial<ValidatedOnboarding> = {}): ValidatedOnboarding {
  return {
    enabled: true,
    mode: "ONBOARDING_ADVANCED",
    defaultChannels: [
      "general",
      "gaming",
      "announcements",
      "events",
      "streams",
      "support",
      "community",
    ],
    prompts: [
      {
        key: "choose-your-path",
        title: "Choose your path",
        type: "MULTIPLE_CHOICE",
        singleSelect: true,
        required: true,
        inOnboarding: true,
        options: [
          { key: "chat", title: "Chat", roles: ["male"], channels: ["gaming"] },
          { key: "get-gud", title: "Get Gud", roles: ["female"], channels: [] },
        ],
      },
    ],
    ...overrides,
  };
}

function run(raw: ValidatedGuildConfig) {
  return runSemanticPass(raw);
}

describe("semantic pass — bare keys", () => {
  it("expands bare role keys into ref:roles.<key>", () => {
    const result = run({ onboarding: buildOnboarding() });
    expect(result.requiredBindings).toContainEqual({
      kind: "roles",
      key: "male",
      ref: "ref:roles.male",
    });
    expect(result.requiredBindings).toContainEqual({
      kind: "roles",
      key: "female",
      ref: "ref:roles.female",
    });
  });

  it("expands bare channel keys into ref:channels.<key>", () => {
    const result = run({ onboarding: buildOnboarding() });
    expect(result.requiredBindings).toContainEqual({
      kind: "channels",
      key: "gaming",
      ref: "ref:channels.gaming",
    });
    expect(result.requiredBindings).toContainEqual({
      kind: "channels",
      key: "general",
      ref: "ref:channels.general",
    });
  });

  it("keeps full refs unchanged when explicitly authored", () => {
    const onboarding = buildOnboarding({
      defaultChannels: ["ref:channels.general", "ref:channels.gaming"],
    });
    const result = run({ onboarding });
    expect(result.requiredBindings).toContainEqual({
      kind: "channels",
      key: "general",
      ref: "ref:channels.general",
    });
  });
});

describe("semantic pass — ref validation", () => {
  it("flags a wrong-kind ref in a kind-scoped array", () => {
    const onboarding = buildOnboarding({ defaultChannels: ["ref:roles.male"] });
    const result = run({ onboarding });
    expect(
      result.errors.some((error) => error.message.includes('kind "roles" but expected "channels"')),
    ).toBe(true);
  });

  it("flags an empty-key ref", () => {
    const onboarding = buildOnboarding({ defaultChannels: ["ref:channels."] });
    const result = run({ onboarding });
    expect(result.errors.some((error) => error.message.includes("empty key"))).toBe(true);
  });
});

describe("semantic pass — separatorRole", () => {
  it("adds the separator role to required bindings", () => {
    const onboarding = buildOnboarding({
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          separatorRole: "pais",
          options: [{ key: "argentina", title: "Argentina", roles: ["argentina"] }],
        },
      ],
    });
    const result = run({ onboarding });
    expect(result.requiredBindings).toContainEqual({
      kind: "roles",
      key: "pais",
      ref: "ref:roles.pais",
    });
  });

  it("expands a fully-qualified separatorRole ref", () => {
    const onboarding = buildOnboarding({
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          separatorRole: "ref:roles.pais",
          options: [{ key: "argentina", title: "Argentina", roles: ["argentina"] }],
        },
      ],
    });
    const result = run({ onboarding });
    expect(result.requiredBindings).toContainEqual({
      kind: "roles",
      key: "pais",
      ref: "ref:roles.pais",
    });
  });
});

describe("semantic pass — business rules", () => {
  it("errors when enabled with fewer than 7 default channels", () => {
    const onboarding = buildOnboarding({ defaultChannels: ["a", "b", "c"] });
    const result = run({ onboarding });
    expect(result.errors.some((error) => error.message.includes("at least 7"))).toBe(true);
  });

  it("allows fewer than 7 default channels when disabled", () => {
    const onboarding = buildOnboarding({ enabled: false, defaultChannels: ["a"] });
    const result = run({ onboarding });
    expect(result.errors).toHaveLength(0);
  });

  it("skips the ≥7 rule and default-channel bindings when manageDefaultChannels is false", () => {
    const onboarding = buildOnboarding({
      manageDefaultChannels: false,
      defaultChannels: ["a", "b", "c"],
    });
    const result = run({ onboarding });
    expect(result.errors).toHaveLength(0);
    // Neither the declared defaults nor the base-set keys require a binding.
    expect(result.requiredBindings.some((b) => b.kind === "channels" && b.key === "a")).toBe(false);
    expect(result.requiredBindings.some((b) => b.kind === "channels" && b.key === "general")).toBe(
      false,
    );
    // Option-level channel refs still resolve (kind-scoped arrays).
    expect(result.requiredBindings).toContainEqual({
      kind: "channels",
      key: "gaming",
      ref: "ref:channels.gaming",
    });
  });

  it("scopes onboardingBindings to the onboarding slice (channel overwrite refs excluded)", () => {
    const result = run({
      onboarding: buildOnboarding(),
      channels: {
        categories: [
          {
            key: "moderation",
            name: "Moderation",
            type: 4,
            overwrites: [
              { ref: "admin", deny: "1024" },
              { ref: "mod", allow: "1024" },
            ],
          },
        ],
        channels: [{ key: "mod-chat", name: "Mod Chat", type: 0, parent: "moderation" }],
      },
    });
    // The full binding set includes the overwrite roles…
    expect(result.requiredBindings).toContainEqual({
      kind: "roles",
      key: "admin",
      ref: "ref:roles.admin",
    });
    expect(result.requiredBindings).toContainEqual({
      kind: "roles",
      key: "mod",
      ref: "ref:roles.mod",
    });
    // …but the onboarding-scoped set only covers the onboarding refs.
    expect(result.onboardingBindings.some((b) => b.kind === "roles" && b.key === "admin")).toBe(
      false,
    );
    expect(result.onboardingBindings.some((b) => b.kind === "roles" && b.key === "mod")).toBe(
      false,
    );
    // Prompt option roles still show up in both.
    expect(result.onboardingBindings).toContainEqual({
      kind: "roles",
      key: "male",
      ref: "ref:roles.male",
    });
  });

  it("throws SemanticErrorException via the strict wrapper", () => {
    const onboarding = buildOnboarding({ defaultChannels: ["a", "b", "c"] });
    expect(() => {
      const result = run({ onboarding });
      if (result.errors.length > 0) throw new SemanticErrorException(result.errors);
    }).toThrow(SemanticErrorException);
  });
});
