import type { ValidatedOnboarding } from "../config/schema/onboarding.js";
import type { ResolvedOnboarding } from "../domain/canonicalize.js";
import type { ManifestData } from "../identity/manifest.js";
import { resolveKeys } from "../identity/resolve.js";
import type { DiscordPort } from "../port/discord-port.js";

/**
 * Phase 3+4 of the pipeline (reconciliation.md §2): discover live state and
 * resolve symbolic refs → manifest bindings → snowflakes.
 *
 * Manifest-strict (slice decision): every referenced logical key MUST have a
 * binding; unbound keys abort with the adopt command hint.
 *
 * The desired config is walked structurally so each ref stays associated with
 * its slot (no substring matching).
 */

export interface Discovery {
  guildId: string;
  channels: Awaited<ReturnType<DiscordPort["listChannels"]>>;
  roles: Awaited<ReturnType<DiscordPort["listRoles"]>>;
  onboarding: Awaited<ReturnType<DiscordPort["getOnboarding"]>>;
}

export interface ResolveResult {
  resolved: ResolvedOnboarding;
  missing: string[];
}

export async function discover(port: DiscordPort, guildId: string): Promise<Discovery> {
  const [channels, roles, onboarding] = await Promise.all([
    port.listChannels(guildId),
    port.listRoles(guildId),
    port.getOnboarding(guildId),
  ]);
  return { guildId, channels, roles, onboarding };
}

/**
 * Resolve the validated config against the manifest. Expansion rules match the
 * semantic pass (bare key → `ref:{kind}.{key}` within kind-scoped arrays).
 *
 * When the config opts out of managing default channels
 * (`manageDefaultChannels: false`), the server's current set is carried over
 * unchanged (`currentDefaultChannelIds`) — no manifest resolution, no missing
 * bindings, and the diff never flags them.
 */
export function resolveDesired(
  onboarding: ValidatedOnboarding,
  manifest: ManifestData,
  currentDefaultChannelIds?: string[],
): ResolveResult {
  const missing: string[] = [];

  // Default channels (kind: channels).
  let defaultChannelIds: string[];
  if (onboarding.manageDefaultChannels === false) {
    defaultChannelIds = currentDefaultChannelIds ?? [];
  } else {
    const defaultRefs = (onboarding.defaultChannels ?? []).map((authored) =>
      expandRef("channels", authored),
    );
    const defaults = resolveKeys(
      manifest,
      defaultRefs.map((entry) => entry.logicalKey),
    );
    missing.push(...defaults.missing);
    defaultChannelIds = defaults.resolved.map((entry) => entry.discordId);
  }

  // Options: roles + channels per slot.
  const prompts = onboarding.prompts.map((prompt) => {
    // Separator role: resolved once per prompt, granted to every option.
    const separator = prompt.separatorRole
      ? resolveKeys(manifest, [expandRef("roles", prompt.separatorRole).logicalKey])
      : undefined;
    if (separator) {
      missing.push(...separator.missing);
    }
    const separatorId = separator?.resolved[0]?.discordId;

    return {
      key: prompt.key,
      title: prompt.title,
      type: prompt.type,
      singleSelect: prompt.singleSelect,
      required: prompt.required,
      inOnboarding: prompt.inOnboarding,
      options: prompt.options.map((option) => {
        const roleRefs = (option.roles ?? []).map((authored) => expandRef("roles", authored));
        const channelRefs = (option.channels ?? []).map((authored) =>
          expandRef("channels", authored),
        );

        const roles = resolveKeys(
          manifest,
          roleRefs.map((entry) => entry.logicalKey),
        );
        const channels = resolveKeys(
          manifest,
          channelRefs.map((entry) => entry.logicalKey),
        );
        missing.push(...roles.missing, ...channels.missing);

        return {
          key: option.key,
          title: option.title,
          description: option.description,
          emoji: option.emoji,
          roleIds: [
            ...roles.resolved.map((entry) => entry.discordId),
            ...(separatorId ? [separatorId] : []),
          ],
          channelIds: channels.resolved.map((entry) => entry.discordId),
        };
      }),
    };
  });

  const resolved: ResolvedOnboarding = {
    enabled: onboarding.enabled,
    mode: onboarding.mode,
    defaultChannelIds,
    prompts,
  };

  return { resolved, missing: [...new Set(missing)] };
}

function expandRef(
  kind: "roles" | "channels",
  authored: string,
): {
  kind: "roles" | "channels";
  key: string;
  /** Logical key as stored in the manifest (no `ref:` prefix). */
  logicalKey: string;
} {
  if (authored.startsWith("ref:")) {
    const dot = authored.indexOf(".");
    const key = dot === -1 ? "" : authored.slice(dot + 1);
    return { kind, key, logicalKey: authored.slice("ref:".length) };
  }
  return { kind, key: authored, logicalKey: `${kind}.${authored}` };
}
