import { describe, expect, it } from "vitest";
import {
  canonicalizeCurrent,
  canonicalizeDesired,
  type ResolvedOnboarding,
} from "../../src/domain/canonicalize.js";
import { diffOnboarding } from "../../src/domain/diff.js";
import type { ApiOnboarding } from "../../src/port/discord-types.js";
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
        ],
      },
    ],
  };
}

describe("diffOnboarding", () => {
  it("NOOP when desired and current converge (order-insensitive channels)", () => {
    const result = diffOnboarding(canonicalizeDesired(desired()), canonicalizeCurrent(current()));
    expect(result.op).toBe("NOOP");
  });

  it("UPDATE when enabled differs", () => {
    const currentState = current();
    currentState.enabled = false;
    const result = diffOnboarding(
      canonicalizeDesired(desired()),
      canonicalizeCurrent(currentState),
    );
    expect(result.op).toBe("UPDATE");
    expect(result.reason).toContain("enabled");
  });

  it("UPDATE when mode differs", () => {
    const currentState = current();
    currentState.mode = 0;
    const result = diffOnboarding(
      canonicalizeDesired(desired()),
      canonicalizeCurrent(currentState),
    );
    expect(result.op).toBe("UPDATE");
    expect(result.reason).toContain("mode");
  });

  it("UPDATE when a prompt title differs", () => {
    const currentState = current();
    requireDefined(currentState.prompts[0], "current prompt").title = "Different title";
    const result = diffOnboarding(
      canonicalizeDesired(desired()),
      canonicalizeCurrent(currentState),
    );
    expect(result.op).toBe("UPDATE");
    expect(result.reason).toContain("prompt[0]");
  });

  it("UPDATE when an option title differs", () => {
    const currentState = current();
    const prompt = requireDefined(currentState.prompts[0], "current prompt");
    requireDefined(prompt.options[0], "current option").title = "Gaming";
    const result = diffOnboarding(
      canonicalizeDesired(desired()),
      canonicalizeCurrent(currentState),
    );
    expect(result.op).toBe("UPDATE");
  });

  it("UPDATE when role_ids differ (order-insensitive)", () => {
    const currentState = current();
    const prompt = requireDefined(currentState.prompts[0], "current prompt");
    requireDefined(prompt.options[0], "current option").role_ids = ["222"];
    const result = diffOnboarding(
      canonicalizeDesired(desired()),
      canonicalizeCurrent(currentState),
    );
    expect(result.op).toBe("UPDATE");
  });

  it("is idempotent: diffing the result of an apply converges", () => {
    // Simulate a POST-apply state where the server assigned new prompt/option ids.
    const serverState: ApiOnboarding = {
      ...current(),
      prompts: current().prompts.map((prompt) => ({
        ...prompt,
        id: "server-generated-1",
        options: prompt.options.map((option) => ({ ...option, id: "server-generated-2" })),
      })),
    };
    const result = diffOnboarding(canonicalizeDesired(desired()), canonicalizeCurrent(serverState));
    expect(result.op).toBe("NOOP");
  });
});
