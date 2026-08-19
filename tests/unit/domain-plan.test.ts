import { describe, expect, it } from "vitest";
import { canonicalizeDesired, type ResolvedOnboarding } from "../../src/domain/canonicalize.js";
import { buildPayload, buildPlan } from "../../src/domain/plan.js";
import type { ApiOnboarding, OnboardingPutBody } from "../../src/port/discord-types.js";
import { requireDefined } from "../helpers/require-defined.js";

function desired(): ResolvedOnboarding {
  return {
    enabled: true,
    mode: "ONBOARDING_ADVANCED",
    defaultChannelIds: ["7", "1", "5"],
    prompts: [
      {
        key: "choose-your-path",
        title: "Choose your path",
        type: "MULTIPLE_CHOICE",
        singleSelect: true,
        required: true,
        inOnboarding: true,
        options: [
          {
            key: "chat",
            title: "Chat",
            description: "Join the chat channels",
            roleIds: ["111"],
            channelIds: ["5"],
          },
          {
            key: "get-gud",
            title: "Get Gud",
            roleIds: [],
            channelIds: [],
          },
        ],
      },
    ],
  };
}

function current(): ApiOnboarding {
  return {
    guild_id: "123",
    enabled: true,
    mode: 1,
    default_channel_ids: ["5", "1", "7"],
    prompts: [
      {
        id: "900",
        title: "Choose your path",
        type: 0,
        single_select: true,
        required: true,
        in_onboarding: true,
        options: [
          {
            id: "901",
            title: "Chat",
            description: "Join the chat channels",
            role_ids: ["111"],
            channel_ids: ["5"],
          },
          { id: "902", title: "Get Gud", role_ids: [], channel_ids: [] },
        ],
      },
      {
        id: "910",
        title: "Old prompt",
        type: 0,
        single_select: false,
        required: false,
        in_onboarding: true,
        options: [],
      },
    ],
  };
}

describe("buildPlan", () => {
  it("returns NOOP when diff is NOOP", () => {
    const plan = buildPlan({
      desired: desired(),
      desiredCanonical: canonicalizeDesired(desired()),
      current: current(),
      diff: "NOOP",
    });
    expect(plan.op).toBe("NOOP");
    expect(plan.payload).toBeUndefined();
  });

  it("returns a single UPDATE with payload when diff is UPDATE", () => {
    const plan = buildPlan({
      desired: desired(),
      desiredCanonical: canonicalizeDesired(desired()),
      current: current(),
      diff: "UPDATE",
      diffReason: "enabled differs",
    });
    expect(plan.op).toBe("UPDATE");
    expect(plan.id).toContain("onboarding");
    expect(plan.payload).toBeDefined();
    expect(plan.safety.safe).toBe(true);
  });
});

describe("buildPayload", () => {
  it("reuses existing prompt ids matched by title", () => {
    const payload = buildPayload(desired(), current());
    expect(payload.prompts[0]?.id).toBe("900");
  });

  it("generates an id for genuinely new prompts", () => {
    const desiredState = desired();
    desiredState.prompts.push({
      key: "new-prompt",
      title: "Brand new",
      type: "DROPDOWN",
      options: [{ key: "o", title: "O", roleIds: [], channelIds: [] }],
    });
    const payload = buildPayload(desiredState, current());
    expect(payload.prompts[1]?.id).toMatch(/^\d+$/);
  });

  it("reuses option ids within a matched prompt by title", () => {
    const payload = buildPayload(desired(), current());
    expect(payload.prompts[0]?.options[0]?.id).toBe("901");
    expect(payload.prompts[0]?.options[1]?.id).toBe("902");
  });

  it("generates ids for options not present in current", () => {
    const desiredState = desired();
    const prompt = requireDefined(desiredState.prompts[0], "desired prompt");
    prompt.options.push({
      key: "events",
      title: "Events",
      roleIds: [],
      channelIds: ["5"],
    });
    const payload = buildPayload(desiredState, current());
    expect(payload.prompts[0]?.options[2]?.id).toBeUndefined();
  });

  it("sorts default channel ids", () => {
    const payload = buildPayload(desired(), current());
    expect(payload.default_channel_ids).toEqual(["1", "5", "7"]);
  });

  it("emits in_onboarding: false explicitly for prompts without inOnboarding", () => {
    // JSON.stringify omits undefined fields; Discord defaults a missing
    // in_onboarding to true, flooding the flow with post-join prompts and
    // tripping the 5-in-flow limit. The payload must never omit the field.
    const desiredState = desired();
    desiredState.prompts.push({
      key: "post-join",
      title: "Post-join",
      type: "DROPDOWN",
      options: [{ key: "o", title: "O", roleIds: [], channelIds: [] }],
    });
    const payload = buildPayload(desiredState, current());
    expect(payload.prompts[1]?.in_onboarding).toBe(false);
    // And the serialized body must contain the field (not be dropped).
    expect(JSON.stringify(payload)).toContain('"in_onboarding":false');
  });

  it("maps mode and type to integers", () => {
    const payload = buildPayload(desired(), current());
    expect(payload.mode).toBe(1);
    expect(payload.prompts[0]?.type).toBe(0);
  });

  it("sends emoji as flat fields", () => {
    const desiredState = desired();
    const prompt = requireDefined(desiredState.prompts[0], "desired prompt");
    const desiredOption = requireDefined(prompt.options[0], "desired option");
    desiredOption.emoji = { name: "💬", animated: false };
    const payload = buildPayload(desiredState, current());
    const payloadOption = payload.prompts[0]
      ?.options[0] as OnboardingPutBody["prompts"][number]["options"][number];
    expect(payloadOption.emoji_id).toBeNull();
    expect(payloadOption.emoji_name).toBe("💬");
    expect(payloadOption.emoji_animated).toBe(false);
    // The flat emoji fields must be present, not an `emoji` object.
    expect("emoji" in payloadOption).toBe(false);
  });

  it("omits emoji entirely when none is configured", () => {
    const payload = buildPayload(desired(), current());
    const option = payload.prompts[0]
      ?.options[0] as OnboardingPutBody["prompts"][number]["options"][number];
    expect(option.emoji_id).toBeUndefined();
    expect(option.emoji_name).toBeUndefined();
  });
});
