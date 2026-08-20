import { describe, expect, it } from "vitest";
import {
  ABSENT,
  canonicalizeCurrent,
  canonicalizeDesired,
  type ResolvedOnboarding,
} from "../../src/domain/canonicalize.js";
import type { ApiOnboarding } from "../../src/port/discord-types.js";

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

describe("canonicalizeDesired", () => {
  it("sorts default channel ids into a set order", () => {
    const doc = canonicalizeDesired(desired());
    expect(doc.defaultChannelIds).toEqual(["1", "5", "7"]);
  });

  it("maps mode and prompt type to API integers", () => {
    const doc = canonicalizeDesired(desired());
    expect(doc.mode).toBe(1);
    expect(doc.prompts[0]?.type).toBe(0);
  });

  it("marks absent optional fields with ABSENT", () => {
    const doc = canonicalizeDesired({
      enabled: false,
      defaultChannelIds: [],
      prompts: [],
    });
    expect(doc.mode).toBe(ABSENT);
  });

  it("applies defaults for absent booleans via ABSENT sentinel", () => {
    const doc = canonicalizeDesired(desired());
    expect(doc.prompts[0]?.singleSelect).toBe(true);
    const sparse = canonicalizeDesired({
      enabled: true,
      mode: "ONBOARDING_DEFAULT",
      defaultChannelIds: [],
      prompts: [
        {
          key: "p",
          title: "P",
          type: "DROPDOWN",
          options: [{ key: "o", title: "O", roleIds: [], channelIds: [] }],
        },
      ],
    });
    // Discord persists these as false when absent; canonical treats absent as
    // false to avoid perpetual UPDATE (see post-join inOnboarding fix).
    expect(sparse.prompts[0]?.singleSelect).toBe(false);
    expect(sparse.prompts[0]?.required).toBe(false);
    expect(sparse.prompts[0]?.inOnboarding).toBe(false);
    expect(sparse.prompts[0]?.options[0]?.description).toBe(ABSENT);
  });

  it("matches the payload defaults: emoji animated defaults to false, empty description is none", () => {
    const doc = canonicalizeDesired({
      enabled: true,
      mode: "ONBOARDING_DEFAULT",
      defaultChannelIds: [],
      prompts: [
        {
          key: "p",
          title: "P",
          type: "DROPDOWN",
          options: [
            {
              key: "o",
              title: "O",
              description: "",
              emoji: { name: "🇨🇦" },
              roleIds: [],
              channelIds: [],
            },
          ],
        },
      ],
    });
    const option = doc.prompts[0]?.options[0];
    expect(option?.description).toBe(ABSENT);
    expect(option?.emojiName).toBe("🇨🇦");
    expect(option?.emojiAnimated).toBe(false);
  });
  it("treats missing desired inOnboarding as false (post-join), matching Discord's boolean", () => {
    // The API always returns in_onboarding (boolean); an unset spec field means
    // "not in the onboarding flow" → false, never ABSENT (else perpetual diff).
    const doc = canonicalizeDesired({
      enabled: true,
      mode: "ONBOARDING_DEFAULT",
      defaultChannelIds: [],
      prompts: [
        {
          key: "post-join",
          title: "Post-join",
          type: "DROPDOWN",
          options: [{ key: "o", title: "O", roleIds: [], channelIds: [] }],
        },
      ],
    });
    expect(doc.prompts[0]?.inOnboarding).toBe(false);
  });

  it("treats missing current in_onboarding as false (post-join)", () => {
    const sparse: ApiOnboarding = {
      guild_id: "1",
      enabled: true,
      mode: 0,
      default_channel_ids: [],
      prompts: [
        {
          id: "900",
          title: "Post-join",
          type: 1,
          single_select: false,
          required: false,
          in_onboarding: false,
          options: [{ id: "901", title: "O", role_ids: [], channel_ids: [] }],
        },
      ],
    };
    const doc = canonicalizeCurrent(sparse);
    expect(doc.prompts[0]?.inOnboarding).toBe(false);
  });
});

describe("canonicalizeCurrent", () => {
  it("normalizes current state into the same shape as desired", () => {
    const doc = canonicalizeCurrent(current());
    expect(doc.defaultChannelIds).toEqual(["1", "5", "7"]);
    expect(doc.mode).toBe(1);
    expect(doc.prompts[0]?.title).toBe("Choose your path");
  });

  it("reads the nested emoji object the real API returns", () => {
    const withEmoji: ApiOnboarding = {
      guild_id: "1",
      enabled: true,
      mode: 0,
      default_channel_ids: [],
      prompts: [
        {
          id: "900",
          title: "Country",
          type: 1,
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              id: "901",
              title: "CANADA",
              description: "",
              role_ids: ["111"],
              channel_ids: [],
              // Discord returns the emoji NESTED, never flat emoji_name.
              emoji: { id: null, name: "🇨🇦", animated: false },
            },
          ],
        },
      ],
    };
    const doc = canonicalizeCurrent(withEmoji);
    const option = doc.prompts[0]?.options[0];
    // Discord normalizes a missing description to "" — treated as none.
    expect(option?.description).toBe(ABSENT);
    expect(option?.emojiName).toBe("🇨🇦");
    // Discord echoes animated: false for unicode emojis (not ABSENT).
    expect(option?.emojiAnimated).toBe(false);
  });

  it("treats missing current booleans as ABSENT", () => {
    const sparse: ApiOnboarding = {
      guild_id: "1",
      enabled: false,
      mode: 0,
      default_channel_ids: [],
      prompts: [],
    };
    const doc = canonicalizeCurrent(sparse);
    expect(doc.prompts).toEqual([]);
  });
});
