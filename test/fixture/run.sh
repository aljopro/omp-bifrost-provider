#!/usr/bin/env bash
# Starts a mock OpenAI upstream (:18081) and a real Bifrost gateway (:18080) routed to it.
# Ctrl+C stops both. Then, in another shell:
#   BIFROST_URL=http://127.0.0.1:18080 BIFROST_VIRTUAL_KEY=sk-bf-omp-test-0000000000000000 \
#     omp -e ./src/index.ts --model bifrost/openai/gpt-4o-mini
set -euo pipefail
cd "$(dirname "$0")"
rm -f app/*.db app/*.db-*
bun mock-openai.ts & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
npx -y @maximhq/bifrost -app-dir ./app -port 18080 -host 127.0.0.1
