import { describe, expect, it } from "vitest";
import type { ValidatedOnboarding } from "../../src/config/schema/onboarding.js";
import { onboardingSchema, parseGuildConfig } from "../../src/config/schema/onboarding.js";
import { requireDefined } from "../helpers/require-defined.js";

function validOnboarding(): ValidatedOnboarding {
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
  };
}

describe("onboarding schema", () => {
  it("accepts a valid onboarding config", () => {
    const result = onboardingSchema.safeParse(validOnboarding());
    expect(result.success).toBe(true);
  });

  it("rejects a prompt title over 80 chars", () => {
    const data = validOnboarding();
    const prompt = requireDefined(data.prompts[0], "prompt fixture");
    prompt.title = "x".repeat(81);
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects an option title over 200 chars", () => {
    const data = validOnboarding();
    const prompt = requireDefined(data.prompts[0], "prompt fixture");
    const option = requireDefined(prompt.options[0], "option fixture");
    option.title = "x".repeat(201);
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid prompt type", () => {
    const data = validOnboarding();
    const prompt = requireDefined(data.prompts[0], "prompt fixture");
    prompt.type = "RADIO" as never;
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid mode", () => {
    const data = validOnboarding();
    data.mode = "ONBOARDING_LEGACY" as never;
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate prompt keys", () => {
    const data = validOnboarding();
    data.prompts.push({ ...requireDefined(data.prompts[0], "prompt fixture") });
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate option keys within a prompt", () => {
    const data = validOnboarding();
    const prompt = requireDefined(data.prompts[0], "prompt fixture");
    prompt.options.push({ ...requireDefined(prompt.options[0], "option fixture") });
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects empty defaultChannels", () => {
    const data = validOnboarding();
    data.defaultChannels = [];
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects missing defaultChannels when default channel management is on", () => {
    const data = validOnboarding();
    delete data.defaultChannels;
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("accepts missing defaultChannels when manageDefaultChannels is false", () => {
    const data = validOnboarding();
    delete data.defaultChannels;
    data.manageDefaultChannels = false;
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts manageDefaultChannels false alongside a defaultChannels list", () => {
    const data = validOnboarding();
    data.manageDefaultChannels = false;
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects a wrong-kind ref (roles ref in a channels array)", () => {
    const data = validOnboarding();
    data.defaultChannels = ["ref:roles.male"];
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("accepts a full ref in a kind-scoped array", () => {
    const data = validOnboarding();
    data.defaultChannels = ["ref:channels.general"];
    const result = onboardingSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates via parseGuildConfig and strips nothing unexpected", () => {
    const parsed = parseGuildConfig({ onboarding: validOnboarding() });
    expect(parsed.onboarding?.enabled).toBe(true);
  });
});

describe("onboarding option sugar", () => {
  it("defaults roles to [key] when roles are omitted", () => {
    const result = onboardingSchema.safeParse({
      ...validOnboarding(),
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          options: [{ key: "argentina", title: "Argentina" }],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const prompt = requireDefined(result.data.prompts[0], "parsed prompt");
      const option = requireDefined(prompt.options[0], "parsed option");
      expect(option.roles).toEqual(["argentina"]);
    }
  });

  it("normalizes a string emoji to the object form", () => {
    const result = onboardingSchema.safeParse({
      ...validOnboarding(),
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          options: [{ key: "argentina", title: "Argentina", emoji: "🇦🇷" }],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const prompt = requireDefined(result.data.prompts[0], "parsed prompt");
      const option = requireDefined(prompt.options[0], "parsed option");
      expect(option.emoji).toEqual({ name: "🇦🇷" });
    }
  });

  it("accepts an inline roleId with a single (defaulted) role", () => {
    const result = onboardingSchema.safeParse({
      ...validOnboarding(),
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          options: [{ key: "argentina", title: "Argentina", roleId: "1507545623992209001" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an inline roleId with multiple roles", () => {
    const result = onboardingSchema.safeParse({
      ...validOnboarding(),
      prompts: [
        {
          key: "gender",
          title: "Género",
          type: "MULTIPLE_CHOICE",
          options: [
            {
              key: "hombre",
              title: "Hombre",
              roles: ["hombre", "genero"],
              roleId: "1507545623992209001",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an inline roleId that is not a snowflake", () => {
    const result = onboardingSchema.safeParse({
      ...validOnboarding(),
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          options: [{ key: "argentina", title: "Argentina", roleId: "not-an-id" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("onboarding prompt separator role", () => {
  function parseWithSeparator(separatorRole?: unknown, separatorRoleId?: unknown) {
    return onboardingSchema.safeParse({
      ...validOnboarding(),
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          ...(separatorRole !== undefined ? { separatorRole } : {}),
          ...(separatorRoleId !== undefined ? { separatorRoleId } : {}),
          options: [{ key: "argentina", title: "Argentina", roles: ["argentina"] }],
        },
      ],
    });
  }

  it("accepts a separatorRole with a filled snowflake id", () => {
    expect(parseWithSeparator("pais", "1507545623992209100").success).toBe(true);
  });

  it("accepts a separatorRole with an empty placeholder id", () => {
    expect(parseWithSeparator("pais", "").success).toBe(true);
  });

  it("accepts a separatorRole without an id (adopted via manifest)", () => {
    expect(parseWithSeparator("pais").success).toBe(true);
  });

  it("rejects a separatorRoleId without a separatorRole", () => {
    const result = parseWithSeparator(undefined, "1507545623992209100");
    expect(result.success).toBe(false);
  });

  it("rejects a separatorRoleId that is not a snowflake", () => {
    expect(parseWithSeparator("pais", "not-an-id").success).toBe(false);
  });

  it("rejects a wrong-kind separatorRole ref", () => {
    expect(parseWithSeparator("ref:channels.general").success).toBe(false);
  });
});
