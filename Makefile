# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ────
# Chrysalis — Makefile orchestrator (Docker-only)
# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ────
# Usage: make <target>  (all flows run via `docker compose run`)
#
#   make build            # build Docker image (once)
#   make validate         # validate config offline (no network)
#   make sync             # export source server to config/clone/*.json (reads GUILD_ID from .env)
#   make sync-exclude [CHANNEL=<name>] [ROLE=<name>]   # export with exclusions
#   make create TARGET_ID=<id>          # build target server (dry-run by default)
#   make create-dry TARGET_ID=<id>      # target plan (without applying)
#   make create-yes TARGET_ID=<id>      # build target without confirmation
#   make run CMD="create --yes"  # arbitrary command via Docker
#   make help             # help
#   # NOTE: make does not accept free flags → make create TARGET_ID=<id> --yes  FAILS
#   #       use: make create-yes TARGET_ID=<id>
# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ────

.DEFAULT_GOAL := help

# Compose service that runs the CLI (see docker-compose.yml).
SERVICE ?= chrysalis

# ── Required variables check ──────────────────────────────────────────────
# Targets read .env via the service's env_file; here we only validate
# that the file exists and contains the required values.
# - sync: GUILD_ID from .env = source server (fixed)
# - create: TARGET_ID is the target server (varies per clone, passed by command)
NEEDS_GUILD := sync sync-exclude
NEEDS_TOKEN := $(NEEDS_GUILD) create create-dry create-yes
NEEDS_TARGET := create create-dry create-yes

ifneq ($(filter $(MAKECMDGOALS),$(NEEDS_GUILD)),)
ifeq ($(shell grep -qE '^GUILD_ID=.+' .env 2>/dev/null && echo yes),)
$(error ERROR: GUILD_ID not defined in .env. Edit .env (see .env.example))
endif
endif
ifneq ($(filter $(MAKECMDGOALS),$(NEEDS_TOKEN)),)
ifeq ($(shell grep -qE '^DISCORD_TOKEN=.+' .env 2>/dev/null && echo yes),)
$(error ERROR: DISCORD_TOKEN not defined in .env. Edit .env (see .env.example))
endif
endif
ifneq ($(filter $(MAKECMDGOALS),$(NEEDS_TARGET)),)
ifeq ($(strip $(TARGET_ID)),)
$(error ERROR: TARGET_ID not defined. Run: make create TARGET_ID=<target-server-id>)
endif
endif

# ── Targets ─────────────────────────────────────────────────────────────────

build:  ## Build Docker image
	@docker compose build

validate:  ## Validate config offline (no network)
	@docker compose run --rm $(SERVICE) validate

sync:  ## Export source server to config/clone/*.json (reads GUILD_ID from .env)
	@docker compose run --rm $(SERVICE) sync

sync-exclude:  ## Export with exclusions (CHANNEL/ROLE optional; GUILD_ID from .env)
	@docker compose run --rm $(SERVICE) sync $(if $(CHANNEL),--exclude-channel "$(CHANNEL)",) $(if $(ROLE),--exclude-role "$(ROLE)",)

create:  ## Build target server from config/clone (dry-run by default; requires TARGET_ID)
	@docker compose run --rm $(SERVICE) create --guild $(TARGET_ID)

create-dry:  ## Target plan without applying (requires TARGET_ID)
	@docker compose run --rm $(SERVICE) create --guild $(TARGET_ID) --dry-run

create-yes:  ## Build target without confirmation (requires TARGET_ID)
	@docker compose run --rm $(SERVICE) create --guild $(TARGET_ID) --yes

run:  ## Run arbitrary command: make run CMD="create --guild 123 --yes"
	@test -n "$(CMD)" || { echo "ERROR: CMD not defined. Run: make run CMD=\"create --yes\""; exit 1; }
	@docker compose run --rm $(SERVICE) $(CMD)

# ── Help ───────────────────────────────────────────────────────────────────

help:  ## Show help
	@echo "📚 Chrysalis Makefile targets (Docker) — ideal, pnpm available as local alternative:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = "## "} {printf "  %-20s %s\n", $$1, $$2}'
	@echo ""
	@echo "Workflows (ideal: make | alternative: pnpm):"
	@echo "  Source export:    make sync  |  pnpm sync"
	@echo "  Build target:     make create TARGET_ID=123456789 | make create-dry TARGET_ID=123 | make create-yes TARGET_ID=123"
	@echo "  Local config:     make validate  |  pnpm validate"
	@echo "  Free command:     make run CMD=\"create --guild 123 --yes\"  |  pnpm run create --guild 123 --yes"
	@echo ""
	@echo "Variables:"
	@echo "  .env              - GUILD_ID (source server, for sync) and DISCORD_TOKEN (required)"
	@echo "  TARGET_ID         - target server ID (for create; passed by command, not in .env)"
	@echo "  CHANNEL, ROLE     - sync exclusions (optional)"
	@echo "  CMD               - command for make run (required)"
	@echo ""
	@echo "Examples:"
	@echo "  make build"
	@echo "  make validate            # or pnpm validate"
	@echo "  make sync                # or pnpm sync"
	@echo "  make sync-exclude CHANNEL='SERVER STATS' ROLE='Admin'"
	@echo "  make create-dry TARGET_ID=123456789"
	@echo "  make create-yes TARGET_ID=123456789   # not: make create TARGET_ID=123 --yes"
	@echo "  make run CMD=\"recover-pending roles.admin --id 123 --guild 456\""
	@echo ""
	@echo "Note: make does not accept --yes as free flag; use make create-yes TARGET_ID=<id>"
