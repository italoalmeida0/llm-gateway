#!/usr/bin/env bash
# Wrapper delegating to cross-platform TypeScript build script
exec bun "$(dirname "$0")/build-indirect-all.ts" "$@"
