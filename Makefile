# easyeda2KicadGuiTool - build / install helper
#
#   make install   install everything (Node deps, Python venv + easyeda2kicad), then verify
#   make start     start the app (opens http://localhost:3780)
#
# Works with GNU Make on Linux, macOS and Windows (cmd, PowerShell or Git Bash).
# Recipes only call node / npm so they behave the same in every shell.

NODE ?= node
NPM  ?= npm
PORT ?= 3780

ifeq ($(OS),Windows_NT)
  PLATFORM := windows
else
  UNAME_S := $(shell uname -s)
  PLATFORM := $(if $(filter Darwin,$(UNAME_S)),macos,linux)
endif

# No stderr redirection here: "2>NUL" vs "2>/dev/null" depends on whether make runs
# recipes through cmd or sh on Windows, and the wrong one creates a stray file.
NODE_VERSION := $(strip $(shell $(NODE) --version))

.DEFAULT_GOAL := help
.PHONY: help install check-node node-deps python-deps verify start dev update clean reinstall

help: ## Show this help
	@$(NODE) -e "require('fs').readFileSync('Makefile','utf8').split(/\r?\n/).forEach(l=>{const m=l.match(/^([a-z-]+):.*?## (.*)$$/);if(m)console.log('  make '+m[1].padEnd(13)+m[2])})"

install: check-node node-deps python-deps verify ## Install everything and verify the setup
	@$(NODE) -e "console.log('\n  easyeda2KicadGuiTool is ready - run: make start\n')"

check-node: ## Check that Node.js 18+ is available (installs it if possible)
ifeq ($(NODE_VERSION),)
	@echo Node.js was not found - attempting to install it for $(PLATFORM)...
ifeq ($(PLATFORM),windows)
	winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
	@echo Node.js installed. Open a NEW terminal so PATH is refreshed, then run "make install" again.
else ifeq ($(PLATFORM),macos)
	brew install node
	@echo Node.js installed. Run "make install" again.
else
	@echo Install Node.js 18+ first, for example:
	@echo   nvm:           nvm install --lts
	@echo   Debian/Ubuntu: https://github.com/nodesource/distributions
	@echo   Fedora:        sudo dnf install nodejs
	@echo   Arch:          sudo pacman -S nodejs npm
	@echo then run "make install" again.
endif
	@exit 1
else
	@$(NODE) -e "const v=process.versions.node.split('.').map(Number);if(v[0]<18){console.error('Node.js 18+ is required, found '+process.version);process.exit(1)}console.log('==> Node.js '+process.version+' OK')"
endif

node-deps: ## Install Node.js dependencies (npm install)
	@$(NODE) -e "console.log('==> Installing Node.js dependencies')"
	$(NPM) install --no-fund --no-audit

python-deps: ## Create .venv and install easyeda2kicad into it
	$(NODE) scripts/install.js

verify: ## Check that Python + easyeda2kicad work
	@$(NODE) scripts/check-python.js

check: verify ## Alias for verify

start: ## Start the app and open it in the browser
	$(NODE) server.js

dev: ## Start the app without opening a browser
	$(NODE) server.js --no-open

update: check-node ## Update Node and Python dependencies
	$(NPM) install --no-fund --no-audit
	$(NODE) scripts/install.js --upgrade

clean: ## Remove node_modules and .venv (keeps your ledger in data/)
	@$(NODE) -e "for (const d of ['node_modules','.venv']) { require('fs').rmSync(d,{recursive:true,force:true}); console.log('removed '+d) }"

reinstall: clean install ## Clean, then install from scratch
