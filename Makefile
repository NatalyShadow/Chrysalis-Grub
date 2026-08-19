# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ────
# Chrysalis — Makefile orchestrator (Docker-only)
# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ────
# Uso: make <target>  (todos los flujos corren via `docker compose run`)
#
#   make build            # construir imagen Docker (una sola vez)
#   make validate         # validar config offline (sin red)
#   make sync             # exportar server origen a config/clone/*.json (lee GUILD_ID del .env)
#   make sync-exclude [CHANNEL=<name>] [ROLE=<name>]   # exportar con exclusiones
#   make create TARGET_ID=<id>          # construir server target (dry-run por defecto)
#   make create-dry TARGET_ID=<id>      # plan del target sin ejecutar
#   make create-yes TARGET_ID=<id>      # construir el target sin confirmacion
#   make run CMD="create --yes"  # comando arbitrario via Docker
#   make help             # ayuda
# ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ────

.DEFAULT_GOAL := help

# Servicio de Compose que ejecuta el CLI (ver docker-compose.yml).
SERVICE ?= chrysalis

# ── Verificacion de variables obligatorias ──────────────────────────────────
# Los targets leen .env via el env_file del servicio; aca solo validamos
# que el archivo exista y contenga los valores requeridos.
# - sync: GUILD_ID del .env = server origen (fijo)
# - create: TARGET_ID es el server target (varia por clon, se pasa por comando)
NEEDS_GUILD := sync sync-exclude
NEEDS_TOKEN := $(NEEDS_GUILD) create create-dry create-yes
NEEDS_TARGET := create create-dry create-yes

ifneq ($(filter $(MAKECMDGOALS),$(NEEDS_GUILD)),)
ifeq ($(shell grep -qE '^GUILD_ID=.+' .env 2>/dev/null && echo yes),)
$(error ERROR: GUILD_ID no definido en .env. Editá .env (ver .env.example))
endif
endif
ifneq ($(filter $(MAKECMDGOALS),$(NEEDS_TOKEN)),)
ifeq ($(shell grep -qE '^DISCORD_TOKEN=.+' .env 2>/dev/null && echo yes),)
$(error ERROR: DISCORD_TOKEN no definido en .env. Editá .env (ver .env.example))
endif
endif
ifneq ($(filter $(MAKECMDGOALS),$(NEEDS_TARGET)),)
ifeq ($(strip $(TARGET_ID)),)
$(error ERROR: TARGET_ID no definido. Ejecutá: make create TARGET_ID=<server-target-id>)
endif
endif

# ── Targets ─────────────────────────────────────────────────────────────────

build:  ## Construir imagen Docker
	@docker compose build

validate:  ## Validar config offline (sin red)
	@docker compose run --rm $(SERVICE) validate

sync:  ## Exportar server origen a config/clone/*.json (lee GUILD_ID del .env)
	@docker compose run --rm $(SERVICE) sync

sync-exclude:  ## Exportar con exclusiones (CHANNEL/ROLE opcionales; GUILD_ID del .env)
	@docker compose run --rm $(SERVICE) sync $(if $(CHANNEL),--exclude-channel "$(CHANNEL)",) $(if $(ROLE),--exclude-role "$(ROLE)",)

create:  ## Construir server target desde config/clone (dry-run por defecto; requiere TARGET_ID)
	@docker compose run --rm $(SERVICE) create --guild $(TARGET_ID)

create-dry:  ## Plan del target sin ejecutar (requiere TARGET_ID)
	@docker compose run --rm $(SERVICE) create --guild $(TARGET_ID) --dry-run

create-yes:  ## Construir el target sin confirmacion (requiere TARGET_ID)
	@docker compose run --rm $(SERVICE) create --guild $(TARGET_ID) --yes

run:  ## Ejecutar un comando arbitrario: make run CMD="create --guild 123 --yes"
	@test -n "$(CMD)" || { echo "ERROR: CMD no definido. Ejecutá: make run CMD=\"create --yes\""; exit 1; }
	@docker compose run --rm $(SERVICE) $(CMD)

# ── Ayuda ───────────────────────────────────────────────────────────────────

help:  ## Mostrar ayuda
	@echo "📚 Chrysalis Makefile targets (Docker):"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = "## "} {printf "  %-20s %s\n", $$1, $$2}'
	@echo ""
	@echo "Flujos de trabajo:"
	@echo "  Export del origen:  make sync"
	@echo "  Construir target:   make create TARGET_ID=123456789 | make create-dry TARGET_ID=123 | make create-yes TARGET_ID=123"
	@echo "  Config local:       make validate"
	@echo "  Comando libre:      make run CMD=\"create --guild 123 --yes\""
	@echo ""
	@echo "Variables:"
	@echo "  .env              - GUILD_ID (server origen, para sync) y DISCORD_TOKEN (obligatorios)"
	@echo "  TARGET_ID         - ID del server target (para create; se pasa por comando, no vive en .env)"
	@echo "  CHANNEL, ROLE     - exclusiones de sync (opcionales)"
	@echo "  CMD               - comando para make run (obligatorio)"
	@echo ""
	@echo "Ejemplos:"
	@echo "  make build"
	@echo "  make validate"
	@echo "  make sync"
	@echo "  make sync-exclude CHANNEL='SERVER STATS' ROLE='Admin'"
	@echo "  make create-dry TARGET_ID=123456789"
	@echo "  make create-yes TARGET_ID=123456789"
	@echo "  make run CMD=\"recover-pending roles.admin --id 123 --guild 456\""