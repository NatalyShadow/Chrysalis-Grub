# Sandbox E2E suite (opt-in, never in CI)

This project (`vitest --project sandbox`) is the **throwaway-guild E2E** suite —
Phase 4 of `docs/roadmap.md`. It runs against the real REST API with a disposable
guild and a bot invited with `ADMINISTRATOR`.

- **Opt-in only**: `pnpm test:sandbox`; never part of `pnpm test` / CI.
- Currently **empty** (the suite is scaffolded but not written yet). The
  placeholder test below is `describe.skip` so the script exits 0.
- Job: resolve the UNVERIFIED items in `docs/clone-server.md` §UNVERIFIED and
  `docs/discord-capabilities.md` §13, and prove `create → converge → sync → all
  NOOP` twice against the real API.