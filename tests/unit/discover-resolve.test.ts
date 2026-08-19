import { describe, expect, it } from "vitest";

import type { ValidatedOnboarding } from "../../src/config/schema/onboarding.js";
import { resolveDesired } from "../../src/engine/discover-resolve.js";
import type { ManifestData } from "../../src/identity/types.js";
import { requireDefined } from "../helpers/require-defined.js";

function manifestWith(bindings: ManifestData["bindings"] = {}): ManifestData {
  return {
    meta: { schemaVersion: 1, guildId: "123", createdAt: "x", deletionPolicy: "never" },
    bindings,
  };
}

function binding(kind: "role" | "channel", key: string, discordId: string) {
  return {
    key,
    aliases: [],
    kind,
    discordId,
    createdAt: "x",
  };
}

function buildOnboarding(overrides: Partial<ValidatedOnboarding> = {}): ValidatedOnboarding {
  return {
    enabled: true,
    mode: "ONBOARDING_DEFAULT",
    defaultChannels: ["general"],
    prompts: [
      {
        key: "country",
        title: "Country",
        type: "DROPDOWN",
        separatorRole: "pais",
        options: [
          { key: "argentina", title: "Argentina", roles: ["argentina"] },
          { key: "peru", title: "Perú", roles: ["peru"] },
        ],
      },
    ],
    ...overrides,
  };
}

type ResolvedState = ReturnType<typeof resolveDesired>["resolved"];

function optionAt(resolved: ResolvedState, index: number) {
  const prompt = requireDefined(resolved.prompts[0], "resolved prompt");
  return requireDefined(prompt.options[index], `resolved option ${index}`);
}

describe("resolveDesired — separatorRole", () => {
  it("appends the separator role id to every option's roleIds", () => {
    const manifest = manifestWith({
      "channels.general": binding("channel", "general", "100"),
      "roles.pais": binding("role", "pais", "900"),
      "roles.argentina": binding("role", "argentina", "901"),
      "roles.peru": binding("role", "peru", "902"),
    });
    const { resolved, missing } = resolveDesired(buildOnboarding(), manifest);
    expect(missing).toEqual([]);
    expect(optionAt(resolved, 0).roleIds).toEqual(["901", "900"]);
    expect(optionAt(resolved, 1).roleIds).toEqual(["902", "900"]);
  });

  it("leaves roleIds unchanged when the prompt has no separatorRole", () => {
    const onboarding = buildOnboarding({
      prompts: [
        {
          key: "country",
          title: "Country",
          type: "DROPDOWN",
          options: [{ key: "argentina", title: "Argentina", roles: ["argentina"] }],
        },
      ],
    });
    const manifest = manifestWith({
      "channels.general": binding("channel", "general", "100"),
      "roles.argentina": binding("role", "argentina", "901"),
    });
    const { resolved, missing } = resolveDesired(onboarding, manifest);
    expect(missing).toEqual([]);
    expect(optionAt(resolved, 0).roleIds).toEqual(["901"]);
  });

  it("reports a missing separator role binding", () => {
    const manifest = manifestWith({
      "channels.general": binding("channel", "general", "100"),
      "roles.argentina": binding("role", "argentina", "901"),
      "roles.peru": binding("role", "peru", "902"),
    });
    const { resolved, missing } = resolveDesired(buildOnboarding(), manifest);
    expect(missing).toContain("roles.pais");
    // other options still resolve; the engine aborts on missing
    expect(optionAt(resolved, 0).roleIds).toEqual(["901"]);
  });

  it("dedupes a separator id shared with an option role", () => {
    const onboarding = buildOnboarding({
      prompts: [
        {
          key: "gender",
          title: "Género",
          type: "MULTIPLE_CHOICE",
          separatorRole: "genero",
          options: [{ key: "hombre", title: "Hombre", roles: ["genero", "hombre"] }],
        },
      ],
    });
    const manifest = manifestWith({
      "channels.general": binding("channel", "general", "100"),
      "roles.genero": binding("role", "genero", "910"),
      "roles.hombre": binding("role", "hombre", "911"),
    });
    const { resolved, missing } = resolveDesired(onboarding, manifest);
    expect(missing).toEqual([]);
    expect(optionAt(resolved, 0).roleIds).toEqual(["910", "911", "910"]);
  });
});

describe("resolveDesired — manageDefaultChannels: false", () => {
  it("carries over the current default channel ids without requiring bindings", () => {
    const manifest = manifestWith({
      "roles.pais": binding("role", "pais", "900"),
      "roles.argentina": binding("role", "argentina", "901"),
      "roles.peru": binding("role", "peru", "902"),
    });
    const onboarding = buildOnboarding({ manageDefaultChannels: false });
    const { resolved, missing } = resolveDesired(onboarding, manifest, ["200", "201"]);
    expect(missing).toEqual([]);
    expect(resolved.defaultChannelIds).toEqual(["200", "201"]);
  });

  it("defaults to no default channel ids when no current set is provided", () => {
    const manifest = manifestWith({
      "roles.pais": binding("role", "pais", "900"),
      "roles.argentina": binding("role", "argentina", "901"),
      "roles.peru": binding("role", "peru", "902"),
    });
    const onboarding = buildOnboarding({ manageDefaultChannels: false });
    const { resolved, missing } = resolveDesired(onboarding, manifest);
    expect(missing).toEqual([]);
    expect(resolved.defaultChannelIds).toEqual([]);
  });
});
