# AGENTS.md — Chrysalis

Guía para sesiones de agentes/IA y desarrolladores nuevos en este repositorio.

## Qué es esto

Chrysalis es un **provisioner/reconciliador declarativo de servidores de Discord**
(CLI one-shot, REST puro vía `@discordjs/rest`, sin Gateway ni `Client`). Describes el
estado deseado en una carpeta de fragmentos JSON y Chrysalis construye/reconcilia un
servidor real hacia ese estado.

**Dos verbos:**

1. **`sync` (export del origen):** lee el server origen (read-only) y genera la spec
   ID-free en `config/clone/` (guild/roles/channels **+ onboarding**: `onboarding.json`
   y un `prompt-<key>.json` por prompt).
2. **`create` (construcción del target):** construye el server target desde
   `config/clone/` (create-and-bind, nunca borra). La gestión del onboarding del origen
   quedó **fuera del CLI**: el origen se exporta con `sync` y se clona con `create`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `pnpm validate` | Valida el config **offline** (Zod + semantic pass + pre-flight) |
| `pnpm adopt <kind>.<key> <name>` · `--id <snowflake>` | Binda una key lógica a un snowflake en el manifest |
| `pnpm sync` | Dump read-only del origen (`GUILD_ID` del `.env`) → `config/clone/` (`guild.json`/`roles.json`/`channels.json` + `onboarding.json` + `prompt-*.json`) + mergea los bindings capturados en `manifest.json` |
| `pnpm run create --guild <id> [--config config/clone] [--dry-run] [--yes]` | Construye/reconcilia el **target** contra `manifest.clone.json` (crea + binda + parcha drift; nunca borra; dry-run por defecto; exit 0 converged / 2 applied). El id del target se declara por comando (`--guild <id>`; `GUILD_ID` del `.env` es el origen). Nota: `create` colisiona con el comando nativo `pnpm create` (starter kits), por eso se invoca `pnpm run create` (vía Docker es `chrysalis create`) |
| `pnpm recover-pending <kind>.<key> --id <snowflake> --guild <id>` | Resuelve manualmente un create ambiguo del target y completa el binding (el id del target se pasa explícito) |

## Verificación (gate)

```bash
pnpm typecheck   # tsc --noEmit (TS 7 strict)
pnpm check       # Biome (--write)
pnpm test        # vitest --project unit --project integration
pnpm build       # tsc -p tsconfig.build.json
```

## Layout

- `config/clone/` — **único directorio de config**: `guild.json` / `roles.json` /
  `channels.json` (spec del clon) + `onboarding.json` (base) + un `prompt-<key>.json`
  por prompt. **Todo lo regenera `sync`** (la captura del onboarding es ID-free:
  `separatorRole`/`roles`/`channels` como refs lógicos contra el manifest).
- `.chrysalis/manifest.json` — bindings key lógica ⇄ snowflake del **server origen**
  (lo alimenta `sync`); `.chrysalis/manifest.clone.json` — manifest del **target**
  (create-and-bind, pending creates y lock); `.chrysalis/clone-source.json` —
  trazabilidad de la última exportación.
- `src/` — `cli/` (comandos), `config/` (fragmentos, schema Zod, semantic pass),
  `engine/` (runEngine del onboarding + `runCapture` + `runReconcile`), `identity/`
  (manifest, adopt, journal), `adapters/` (REST + fake en memoria), `port/` (tipos de la API).
- `tests/` — `unit/` + `integration/` (+ `sandbox/` opt-in, vacío, para E2E con server desechable).
- `docs/` — diseño: `architecture.md`, `configuration.md`, `clone-server.md` (flujo clon),
  `reconciliation.md` (engine + exit codes), `roadmap.md`, `decisions/` (ADR-001..004).
- `llm_files/plan.md` — registro de progreso; el bloque **"Estado actual"** al tope es el snapshot
  para retomar el trabajo.
- `llm_files/agents/*.md` — **specs históricas** de la fase de arquitectura (2026-08-11);
  NO reflejan el estado implementado (ver AGENTS.md + `docs/`).

## Modelo de config

- Fragmentos **JSON puros** (un archivo por prompt/kind), merge en load time
  (`mergeFragments`), validación Zod + semantic pass **antes de cualquier llamada a Discord**.
- Identidad: la **key lógica** vive en config; el **snowflake** lo asigna Discord; el
  **manifest es el único vínculo**. Refs: `ref:roles.<key>` o bare key (kind-scoped);
  ref especial `"@everyone"` para overwrites (se resuelve al guild id del target en create).
- Reglas clave: keys `[a-zA-Z0-9_-]`; ref sin binding → error con hint de `adopt`;
  `sync` salta `@everyone`/roles managed y aplica exclusión de subárbol por categoría;
  los refs de overwrites de canales los binda `create-and-bind` en el target. La key de
  cada prompt de onboarding sale del slug del nombre del rol separador (el rol compartido
  por todas sus opciones; `GENDER` → `gender`); las opciones toman la key de su rol
  específico (p. ej. `hombre`).

## Convenciones de código

- TS estricto, **sin `any`/`unknown`**, `exactOptionalPropertyTypes`, imports con extensión
  `.js`, `erasableSyntaxOnly`.
- El puerto (`port/`) usa tipos snake_case del lado de la API; los adapters traducen.
- Sin nuevas dependencias salvo que el plan lo pida; no refactorizar fuera del alcance.

## Estado actual (2026-08-18) y siguientes pasos

- Implementado: onboarding completo (aplicable desde `create` en el target), `sync` = export
  del origen (probado contra el origen: **157 roles / 67 canales / 121 overwrites**, 0 errores
  semánticos; mergea sus bindings en `manifest.json`), **`create`** = reconciler multi-kind
  create-and-bind contra `manifest.clone.json` (dry-run por defecto; exit 0 converged / 2
  applied). `sync` captura también el **onboarding** del origen: `onboarding.json` +
  10 `prompt-*.json` (keys de prompts = slug del rol separador: `gender`, `country`…;
  opciones = key de su rol específico; refs lógicos contra el manifest). El id del origen
  vive en `.env` (`GUILD_ID`); el id del target se declara por comando (`--guild <id>`).
  Eliminados: `adopt-all`, `--manifest`, la reconciliación del origen en el CLI. Config
  consolidado en un solo directorio (`config/clone/`; `config/onboarding/` eliminado).
  194 tests verdes.
- **Siguiente paso:** probar `create` contra un **server desechable** (bot con
  `ADMINISTRATOR`) y confirmar los 4 puntos `UNVERIFIED` de `docs/clone-server.md` §UNVERIFIED.

Los `POST` de roles/canales no son idempotentes: `create` persiste una intención
pendiente antes del POST. Si la respuesta se pierde, el siguiente run recupera un único candidato
exacto o falla cerrado; nunca reintenta a ciegas. Resolver: `pnpm recover-pending roles.<key> --id <snowflake> --guild <target-id>`.