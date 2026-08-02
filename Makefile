# spawnwatcher — build, test, and lint entry points.
#
#   make check   eslint, type check, tests, build
#   make run     run locally against ./data/spawnwatcher.db
#
# Environment config lives encrypted in config/secrets.enc.yaml — see the
# env-* targets and scripts/env.sh.

.PHONY: check run env-edit env-keys env-diff env-push env-pull env-rekey

check:
	npm run check

run:
	npm run dev

# Environment/secrets — config/secrets.enc.yaml, sops+age. See scripts/env.sh.
env-edit:
	./scripts/env.sh edit

env-keys:
	@./scripts/env.sh keys dev
	@echo
	@./scripts/env.sh keys prod

env-diff:
	@./scripts/env.sh diff-prod

env-push:
	./scripts/env.sh push-prod

env-pull:
	./scripts/env.sh pull-prod

env-rekey:
	./scripts/env.sh rekey
