# 🦋 Chrysalis 🐛

> _a server that builds itself — declared, not clicked_

---

🌸 **Chrysalis** is a declarative Discord server provisioner/reconciler.
Describe how your server should look in a folder of tiny JSON fragments, and
Chrysalis turns a fresh guild into the real thing: roles, categories,
channels, permission overwrites and the complete onboarding flow — all from a
single `GUILD_ID`. 🤖🦋✨

---

## 🚀 Quick Start

### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Go to **Bot** → **Reset Token** → copy it
3. Go to **OAuth2 → URL Generator** → check `bot` → permissions: **Administrator** → invite to your server

> 💡 **Administrator** lets Chrysalis manage onboarding (`MANAGE_GUILD` +
> `MANAGE_ROLES`) and enable Community and set full permission overwrites on
> every channel.

### 2. Configure your `.env`

```env
DISCORD_TOKEN=paste_your_token_here
GUILD_ID=paste_your_source_server_id_here
```

> 💡 `GUILD_ID` is the **source** guild (the one `sync` exports from — it
> never changes). The **target** guild id is declared per run when you build a
> clone: `pnpm run create --guild <target-id> --yes`.

### 3. Install & validate

```bash
pnpm install
pnpm validate        # checks the config offline (no network)
```

### 4. Run it

```bash
pnpm run create --guild <target-id> --yes   # builds/reconciles the target server from config/clone
```

That's it — new members get greeted by the prompts you declared. 🦋✨

---

## ✨ Features

🦋 **Declarative onboarding** — 10 prompts, 130 options, all in `config/clone/*.json`
🐛 **Roles on arrival** — every answer grants the right role (+ decorative separator)
📜 **Manifest identity** — logical keys ⇄ snowflake bindings, committed to git
🔁 **Idempotent** — re-runs converge to a NOOP, never churn IDs
🧩 **Fragment merge** — base + one file per prompt, composed at load time
🐳 **Docker-ready** — multi-stage, non-root, read-only root FS
🧪 **Tested** — 189 unit + integration tests
🧯 **Crash-safe creates** — pending POSTs recover or fail closed, never blind-retry

---

## ⚙️ Configuration

### `.env`

| Variable      | Required | Description                     |
| ------------- | :------: | ------------------------------- |
| `DISCORD_TOKEN` |    ✅    | Bot token from the Developer Portal |
| `GUILD_ID`    |    ✅    | Source server (guild) id — the one `sync` exports from |

### `config/clone/`

| File                  | Contents                                                       |
| --------------------- | -------------------------------------------------------------- |
| `onboarding.json`     | Base fields (`enabled`, `mode`, `manageDefaultChannels`)       |
| `prompt-*.json`       | One file per onboarding prompt (title, type, options → roles)  |
| `guild.json`          | Guild settings (`name`, verification, community, …)           |
| `roles.json`          | Roles to create (synced or authored)                          |
| `channels.json`       | Categories + channels with overwrites                         |

```
config/
└── clone/
    ├── onboarding.json
    ├── prompt-age.json
    ├── prompt-country.json
    ├── ...
    ├── guild.json
    ├── roles.json
    └── channels.json
```

### Manifest

`.chrysalis/manifest.json` binds every logical key (e.g. `roles.arabic-race`)
to a real Discord snowflake — the only link between config and server.
`sync` (export) feeds it from the source guild; `create` writes the target
bindings into `.chrysalis/manifest.clone.json`.

---

## 🪱 Usage

Two verbs:

- **`sync`** — read-only export of a live server into ID-free config fragments
  (`config/clone/*.json`).
- **`create`** — build/reconcile a server from those fragments (create-and-bind,
  never deletes; dry-run by default).

| Command                 | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `pnpm validate`         | Validate config offline (Zod + semantic pass)       |
| `pnpm adopt`            | Bind one logical key by name or snowflake           |
| `pnpm sync`             | Dump the source guild (`GUILD_ID` from `.env`) into ID-free config fragments + merge bindings into `manifest.json` |
| `pnpm run create --guild <id> [--dry-run] [--yes]` | Build/reconcile the target from `config/clone` against `manifest.clone.json` (exit 0 converged / 2 applied) |
| `pnpm recover-pending`  | Resolve an ambiguous target create by explicit snowflake |

> 💡 `create` is **dry-run by default**: it prints the plan and asks for
> confirmation. `--yes` skips the prompt. It never deletes — it creates what's
> missing and patches drift on the target guild. The target id is declared per
> run (`--guild <id>`): `GUILD_ID` in `.env` is the source. (Note: `create`
> collides with pnpm's own starter-kit command, so it is invoked as
> `pnpm run create`; via Docker it is just `chrysalis create`.)
>
> 🧬 The clone flow (`sync` → `create`) is documented in
> `docs/clone-server.md`.

### 🐳 Docker

```bash
docker compose run --rm chrysalis validate
docker compose run --rm chrysalis sync            # exports GUILD_ID from .env
docker compose run --rm chrysalis create --guild <target-id> --yes
```

---

## 🐝 How it works

```
   🦋 Config (config/clone/*.json)
    │
    ├─ 🧩 mergeFragments
    ├─ ✅ Zod + semantic validation
    ├─ 📜 resolve logical keys → manifest → snowflakes
    ├─ 🔍 discover live onboarding (GET)
    ├─ 🆚 diff desired vs live
    └─ 📝 plan
         │
         ├─ ⚪ NOOP  → "already converged" (exit 0)
         └─ 🔁 UPDATE → PUT onboarding → re-verify (exit 2)
```

---

## 🔮 Roadmap

- ✅ 🧬 **`sync`** — dump a live server into config fragments (ID-free logical refs)
- ✅ 🏗️ **`create`** — build a fresh server from scratch: roles, channels, overwrites, Community, onboarding
- 📖 See `docs/clone-server.md` for the full design

---

## 🌻 Troubleshooting

### 🐛 "unbound keys" on `pnpm validate`

`sync` (export) merges the captured bindings into `manifest.json`; anything
still unbound needs a manual `pnpm adopt`.

### 🐛 `create` wants to change things I didn't expect

It's dry-run by default: read the plan, adjust the config, re-run.

### 🐛 "config fragment X is not valid JSON"

The loader reads every `*.json` in `config/clone/` — fix the syntax and re-run.

### 🐛 Wrong role granted by an option

Two options sharing the same logical key collide in the manifest — give the
option a unique key and re-export (or adopt) it.

### 🐛 "pending create" after a timeout or crash

`create` persists a pending intent before every role/channel POST. If Discord
may have accepted a request but Chrysalis lost the response, it will not POST
again automatically. Inspect the target guild and resolve the exact resource
explicitly:

```bash
pnpm recover-pending roles.admin --id <snowflake> --guild <target-id>
pnpm run create --guild <target-id> --yes
```

If zero or multiple exact candidates exist, do not guess: resolve the target
state manually before retrying. The target manifest must be writable; a
read-only container must mount a writable `.chrysalis` state volume.

---

## 💌

Made with 🦋 🐛 and 🤖 by a chrysalis that dreams of being a butterfly.

_Declare it once, and let the cocoon do the work._