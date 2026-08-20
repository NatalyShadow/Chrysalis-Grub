import { z } from "zod";

import { EVERYONE_REF, type OnboardingConfig } from "../types.js";

/** Allowed bare-key reference kinds within kind-scoped arrays. */
const bareRefKinds = ["roles", "channels"] as const;
type BareRefKind = (typeof bareRefKinds)[number];

const bareKeyPattern = /^[a-zA-Z0-9_-]+$/;

/** Discord snowflakes are 17–20 digit ids. */
const snowflakePattern = /^\d{17,20}$/;

/** A ref is either `ref:kind.key` or a bare key (expanded by kind context). */
function refSchema(kind: BareRefKind | "both") {
  return z.string().refine(
    (value) => {
      // The special @everyone overwrite ref (implicit role, resolved to the
      // guild id at create time) is always allowed.
      if (value === EVERYONE_REF) return true;
      if (value.startsWith("ref:")) {
        const rest = value.slice("ref:".length);
        if (kind !== "both" && !rest.startsWith(`${kind}.`)) {
          return false;
        }
        return bareKeyPattern.test(rest.split(".").at(-1) ?? "");
      }
      // bare key
      return bareKeyPattern.test(value);
    },
    {
      message:
        kind === "both"
          ? "must be `ref:kind.key` or a bare key"
          : `must be \`ref:${kind}.key\` or a bare key (kind-scoped)`,
    },
  );
}

export const onboardingEmojiSchema = z.object({
  name: z.string().min(1).max(32),
  animated: z.boolean().optional(),
});

/**
 * Emoji authoring sugar: a bare string (`"🇦🇷"`) or the canonical object
 * (`{ "name": "🇦🇷", "animated": false }`). Normalized to the object form.
 */
export const emojiInputSchema = z.preprocess(
  (value) => (typeof value === "string" ? { name: value } : value),
  onboardingEmojiSchema.optional(),
);

export const onboardingOptionSchema = z
  .object({
    key: z.string().min(1).max(64).regex(bareKeyPattern, {
      message: "must be [a-zA-Z0-9_-] (it defaults the role key when roles are omitted)",
    }),
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    emoji: emojiInputSchema,
    roles: z.array(refSchema("roles")).optional(),
    channels: z.array(refSchema("channels")).optional(),
    /**
     * Inline role binding: the snowflake id of the option's single role.
     * An empty string (`""`) is a placeholder — accepted by the schema as an
     * unfilled marker until a real id is placed.
     */
    roleId: z
      .string()
      .refine((value) => value === "" || snowflakePattern.test(value), {
        message: "must be a snowflake (17-20 digits) or empty (unfilled placeholder)",
      })
      .optional(),
  })
  .superRefine((option, ctx) => {
    if (option.roleId !== undefined) {
      const roles = option.roles ?? [option.key];
      if (roles.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roleId"],
          message:
            `roleId requires exactly one role; option "${option.key}" ` +
            `declares ${roles.length} (${roles.join(", ")}). Omit roles to default to ["${option.key}"].`,
        });
      }
    }
  })
  .transform((option) => ({
    ...option,
    roles: option.roles ?? [option.key],
  }));

export const onboardingPromptSchema = z
  .object({
    key: z.string().min(1).max(64),
    title: z.string().min(1).max(80),
    type: z.enum(["MULTIPLE_CHOICE", "DROPDOWN"]),
    singleSelect: z.boolean().optional(),
    required: z.boolean().optional(),
    inOnboarding: z.boolean().optional(),
    /**
     * Separator role: a role logical key granted to everyone who answers any
     * option of this prompt. Declared once at prompt level; the resolver adds
     * its snowflake to every option's role_ids.
     */
    separatorRole: refSchema("roles").optional(),
    /**
     * Inline binding for the separator role: the snowflake id of the role.
     * An empty string (`""`) is a placeholder — accepted by the schema as an
     * unfilled marker until a real id is placed.
     */
    separatorRoleId: z
      .string()
      .refine((value) => value === "" || snowflakePattern.test(value), {
        message: "must be a snowflake (17-20 digits) or empty (unfilled placeholder)",
      })
      .optional(),
    options: z.array(onboardingOptionSchema).min(1),
  })
  .superRefine((prompt, ctx) => {
    if (prompt.separatorRoleId !== undefined && prompt.separatorRole === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["separatorRoleId"],
        message: `prompt "${prompt.key}" has a separatorRoleId but no separatorRole; add "separatorRole": "<key>"`,
      });
    }
    const keys = prompt.options.map((option) => option.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: `duplicate option keys within prompt "${prompt.key}": ${keys.join(", ")}`,
      });
    }
  });

export const onboardingSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["ONBOARDING_DEFAULT", "ONBOARDING_ADVANCED"]).optional(),
    /**
     * When `false`, default channels are left untouched: the server's current
     * set is carried through and never diffed, and only prompts are applied.
     * Defaults to `true` (full default-channel reconciliation).
     */
    manageDefaultChannels: z.boolean().optional(),
    defaultChannels: z.array(refSchema("channels")).min(1).optional(),
    prompts: z.array(onboardingPromptSchema).min(1),
  })
  .superRefine((onboarding, ctx) => {
    if (onboarding.manageDefaultChannels !== false && onboarding.defaultChannels === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultChannels"],
        message:
          `required unless "manageDefaultChannels" is false ` +
          `(add "defaultChannels": [...] or "manageDefaultChannels": false)`,
      });
    }
    const keys = onboarding.prompts.map((prompt) => prompt.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompts"],
        message: `duplicate prompt keys: ${keys.join(", ")}`,
      });
    }
  });

/** Guild-level settings (`guild` fragment). */
export const guildSettingsSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    verificationLevel: z.number().int().min(0).max(4).optional(),
    explicitContentFilter: z.number().int().min(0).max(2).optional(),
    defaultMessageNotifications: z.number().int().min(0).max(1).optional(),
    preferredLocale: z.string().min(2).max(64).optional(),
    community: z
      .object({
        rulesChannel: refSchema("channels").optional(),
        publicUpdatesChannel: refSchema("channels").optional(),
      })
      .optional(),
  })
  .superRefine((guild, ctx) => {
    if (guild.community) {
      if (!guild.community.rulesChannel || !guild.community.publicUpdatesChannel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["community"],
          message:
            `community requires both "rulesChannel" and "publicUpdatesChannel" ` +
            `(PATCH /guilds/{id} needs both ids in the same request)`,
        });
      }
      const both = guild.community.rulesChannel && guild.community.publicUpdatesChannel;
      if (both && guild.community.rulesChannel === guild.community.publicUpdatesChannel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["community"],
          message: `community channels must differ ("rulesChannel" === "publicUpdatesChannel")`,
        });
      }
    }
  });

/** A single role declaration. */
export const roleSchema = z.object({
  key: z.string().min(1).max(64).regex(bareKeyPattern, {
    message: "must be [a-zA-Z0-9_-]",
  }),
  name: z.string().min(1).max(100),
  color: z.number().int().min(0).max(0xffffff).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z
    .string()
    .regex(/^\d+$/, { message: "must be a base-10 bitfield string" })
    .optional(),
  icon: z.string().optional(),
  unicodeEmoji: z.string().max(32).optional(),
});

/** Full role inventory (`roles` fragment). */
export const rolesSchema = z
  .object({
    roles: z.array(roleSchema).min(1),
    /** Position order (top-first). Must be a permutation of all role keys. */
    ordering: z.array(z.string().regex(bareKeyPattern)).optional(),
  })
  .superRefine((roles, ctx) => {
    const keys = roles.roles.map((role) => role.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles"],
        message: `duplicate role keys: ${keys.join(", ")}`,
      });
    }
    if (roles.ordering) {
      if (new Set(roles.ordering).size !== roles.ordering.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering"],
          message: `duplicate keys in ordering: ${roles.ordering.join(", ")}`,
        });
      }
      const unknown = roles.ordering.filter((key) => !keys.includes(key));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering"],
          message: `ordering references unknown role keys: ${unknown.join(", ")}`,
        });
      }
      const missing = keys.filter((key) => !roles.ordering?.includes(key));
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering"],
          message: `ordering must include every role key; missing: ${missing.join(", ")}`,
        });
      }
    }
  });

const overwriteSchema = z.object({
  ref: refSchema("roles"),
  allow: z.string().regex(/^\d+$/, { message: "must be a base-10 bitfield string" }).optional(),
  deny: z.string().regex(/^\d+$/, { message: "must be a base-10 bitfield string" }).optional(),
});

/** A single channel declaration (category or child). */
export const channelSchema = z.object({
  key: z.string().min(1).max(64).regex(bareKeyPattern, {
    message: "must be [a-zA-Z0-9_-]",
  }),
  name: z.string().min(1).max(100),
  type: z.number().int().min(0).max(15),
  parent: refSchema("channels").optional(),
  topic: z.string().max(1024).optional(),
  nsfw: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(21_600).optional(),
  bitrate: z.number().int().min(0).optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
  videoQualityMode: z.number().int().min(1).max(2).optional(),
  defaultAutoArchiveDuration: z.number().int().optional(),
  availableTags: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        emojiName: z.string().max(32).optional(),
        // Forum tag moderated flag — captured always (true/false) to keep
        // fingerprint stable; emojiId preserves custom emoji snowflake.
        moderated: z.boolean().optional(),
        emojiId: z
          .string()
          .regex(/^\d+$/, { message: "must be a snowflake" })
          .optional()
          .nullable(),
      }),
    )
    .max(20)
    .optional(),
  overwrites: z.array(overwriteSchema).optional(),
});

/** Full channel inventory (`channels` fragment). */
export const channelsSchema = z
  .object({
    categories: z.array(channelSchema).optional(),
    channels: z.array(channelSchema).optional(),
    /** Position order (categories first, then children grouped by parent). */
    ordering: z.array(z.string().regex(bareKeyPattern)).optional(),
  })
  .superRefine((channels, ctx) => {
    const all = [...(channels.categories ?? []), ...(channels.channels ?? [])];
    const keys = all.map((channel) => channel.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channels"],
        message: `duplicate channel keys: ${keys.join(", ")}`,
      });
    }
    const categoryKeys = new Set((channels.categories ?? []).map((channel) => channel.key));
    for (const channel of all) {
      if (channel.parent !== undefined) {
        const parentKey = refKey(channel.parent);
        if (!categoryKeys.has(parentKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [`channels[${channel.key}].parent`],
            message: `parent "${channel.parent}" is not a declared category key`,
          });
        }
      }
    }
    for (const category of channels.categories ?? []) {
      if (category.parent !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`categories[${category.key}].parent`],
          message: `categories cannot have a parent ("${category.key}")`,
        });
      }
    }
    if (channels.ordering) {
      if (new Set(channels.ordering).size !== channels.ordering.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering"],
          message: `duplicate keys in channel ordering: ${channels.ordering.join(", ")}`,
        });
      }
      const unknown = channels.ordering.filter((key) => !keys.includes(key));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering"],
          message: `ordering references unknown channel keys: ${unknown.join(", ")}`,
        });
      }
      const missing = keys.filter((key) => !channels.ordering?.includes(key));
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering"],
          message: `ordering must include every channel key; missing: ${missing.join(", ")}`,
        });
      }
    }
  });

/** Extract the bare key from `ref:kind.key` or a bare key. */
function refKey(authored: string): string {
  if (authored.startsWith("ref:")) {
    const dot = authored.indexOf(".");
    return dot === -1 ? authored : authored.slice(dot + 1);
  }
  return authored;
}

export const guildConfigSchema = z.object({
  onboarding: onboardingSchema.optional(),
  guild: guildSettingsSchema.optional(),
  roles: rolesSchema.optional(),
  channels: channelsSchema.optional(),
});

export type OnboardingOption = z.infer<typeof onboardingOptionSchema>;
export type OnboardingPrompt = z.infer<typeof onboardingPromptSchema>;
export type ValidatedOnboarding = z.infer<typeof onboardingSchema>;
export type ValidatedGuildConfig = z.infer<typeof guildConfigSchema>;
export type ValidatedGuildSettings = z.infer<typeof guildSettingsSchema>;
export type ValidatedRoles = z.infer<typeof rolesSchema>;
export type ValidatedRole = z.infer<typeof roleSchema>;
export type ValidatedChannels = z.infer<typeof channelsSchema>;
export type ValidatedChannel = z.infer<typeof channelSchema>;

/** Marker so validators return the runtime-inferred type. */
export function parseOnboarding(data: OnboardingConfig): ValidatedOnboarding {
  return onboardingSchema.parse(data);
}

export function parseGuildConfig(data: unknown): ValidatedGuildConfig {
  return guildConfigSchema.parse(data);
}
