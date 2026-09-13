#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build:standalone
