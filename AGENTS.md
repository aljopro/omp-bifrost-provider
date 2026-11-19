# AGENTS.md

An [oh-my-pi](https://omp.sh) (omp) extension that registers a `bifrost` model provider for the [Bifrost AI Gateway](https://github.com/maximhq/bifrost). Models are discovered from Bifrost and served through omp's built-in `openai-completions` transport. Virtual-key budgets and rate limits are reported to omp's `/usage`.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | Extension entry (default export). Config resolution, URL normalization, model discovery and mapping, catalog enrichment, `/login bifrost`, `/bifrost status\|refresh`, `registerProvider`. |
| `src/usage.ts` | Bifrost quota → omp `UsageReport` (`registerProvider`'s `usage` hook). |
| `test/*.test.ts` | `bun test` unit tests. One live test runs only when `BIFROST_TEST_URL` is set. |
| `test/fixture/` | Local Bifrost + mock OpenAI upstream for end-to-end checks (see Testing). |

The package's `omp.extensions` field points at `./src/index.ts`. omp runs the TypeScript directly, so there is no build step. Published files: `src/`, `README.md`, `LICENSE`.

## Commands

```bash
bun install
bun run check        # tsc --noEmit; must be clean
bun test             # unit tests
./test/fixture/run.sh   # foreground: mock upstream :18081 + Bifrost :18080
```

Run both `check` and `test` before committing.

## omp facts (verified against omp 18.20 and 19.0 source, not obvious from docs)

- **Imports.** `@oh-my-pi/pi-ai`, `pi-catalog`, `pi-coding-agent`, `pi-utils` and `pi-tui` resolve to the copies bundled inside the omp binary at runtime. They are devDependencies here only for types. Don't add runtime deps on them.
- **`registerProvider(name, config)`** (`ProviderConfig` in `pi-coding-agent` `extensibility/extensions/types.ts`):
  - `apiKey` is an env-var *name* or a literal. With `oauth` set, it is only a fallback: a key saved by `/login` wins.
  - `fetchDynamicModels(apiKey)` goes through omp's SQLite model cache (24 h TTL). Returning `models` alongside it keeps them as static fallbacks.
  - Calling `registerProvider` again replaces the registration. That is how `/login` and `/bifrost refresh` push new models immediately.
  - **Never pass a provider-level `baseUrl`.** omp applies an extension's provider `baseUrl` to *every* model of the provider, overwriting each row's own `baseUrl` (models.yml scopes it per api with `baseUrlApis`; extensions can't). With it set, native Anthropic rows were sent to `{root}/v1` → omp strips `/v1` → `POST {root}/v1/messages` → Bifrost 405. Every discovered row carries its own `baseUrl` instead.
  - Static `models` require a provider `baseUrl` (validation), so this provider never passes them. To push a new catalog, re-`registerProvider` and call `ctx.modelRegistry.refreshDiscoverableProviders(["bifrost"], "online")`.
- **Headers.** With the built-in transport, omp always sends `Authorization: Bearer <apiKey>` and the provider config can't suppress it. `before_provider_request` can rewrite only the body. Both the bearer and per-request headers (e.g. `x-bf-session-id`) *can* be controlled from a custom `streamSimple` that calls `streamOpenAICompletions` from `@oh-my-pi/pi-ai/providers/register-builtins` and passes `apiKey: NO_AUTH_SENTINEL` (from `@oh-my-pi/pi-ai`) to drop the bearer. The unrelated npm `omp-bifrost-provider` does this. Not done here (yet), because it needs a custom `api` id and the model rows lose openai-completions-specific handling elsewhere in omp.
- **Usage hook.** `usage: UsageProvider`. With `usesRequestKey: true`, omp probes with exactly the key inference sends. A `null` result means "no data" and triggers a `failureBackoffMs` cooldown, which is how unsupported gateways stay quiet.
- **Notifications.** Use `ctx.ui.notify` only after `session_start`, and queue anything earlier. Writing to stdout or stderr while the TUI owns the terminal garbles it. In non-TTY (`-p`) runs, stderr is fine.
- **Thinking.** Use `{ mode: "effort", efforts: [...] }`. Valid efforts are `minimal|low|medium|high|xhigh|max`; omp sends the effort as `reasoning_effort`.
- **Native Anthropic rows** (`api: "anthropic-messages"`): omp's transport sends `x-api-key`, three cache breakpoints (tools, system, last message), Claude Code client headers (`user-agent: claude-cli/…`), and adaptive thinking from the catalog's `anthropic-adaptive` mode. The 1 h cache (`ttl: "1h"`) is sent only when retention is `long` **and** `compat.supportsLongCacheRetention` is true; omp sets that for Anthropic's official endpoint only, so native rows declare it. Don't copy the catalog's Claude `compat`: it describes the official endpoint (message threads, server compaction, Claude Code instruction injection).
- **Prompt caching.** Anthropic-style `cache_control` markers go out on the chat-completions path only when a model's `compat.cacheControlFormat` is `"anthropic"` (`maybeAddAnthropicCacheControl` in pi-ai `openai-completions.ts`: one ephemeral breakpoint on the last non-empty text part). omp's catalog sets it only for OpenRouter + Anthropic, so this provider must set it itself for Claude (`usesAnthropicCaching`). Without it, Claude via Bifrost never caches. That was the 0.2.2 bug: a real trial billed 28.9M input tokens with zero cache reuse.
- **Model cache vs. code changes.** Discovered rows, including `compat`, are cached in SQLite for 24 h, and omp loads provider rows lazily, so `ctx.modelRegistry.getAll()` holds no `bifrost` rows at `session_start`. When `toModelConfig` output changes, bump `CATALOG_VERSION` in `src/index.ts`. The next session sees the stored version (`<agentDir>/bifrost-catalog.json`) is older and calls `refreshDiscoverableProviders(["bifrost"], "online")`. That session's already-chosen model keeps the old settings; the fix applies from the session after.
- **Debugging requests.** A throwaway extension with `pi.on("before_provider_request", e => …e.payload…)` writing to stderr in `-p` mode shows the exact body omp sends. Keep it outside the repo.

## Bifrost facts (verified against a real gateway)

- Native OpenAI-compatible API: `{root}/v1/models`, `{root}/v1/chat/completions`. The `/openai/v1` integration route also works. Model ids are `provider/model`.
- Governance is on by default. Once virtual keys exist, inference needs one.
- A virtual key is accepted via `x-bf-vk` **or** as `Authorization: Bearer sk-bf-…`. A non-VK bearer next to `x-bf-vk` is ignored unless `allow_direct_keys` is enabled.
- `/v1/models` often includes `context_length`, `max_output_tokens`, `pricing` (USD **per token**, as strings) and `reasoning.supported_efforts`. It often omits them for OpenAI-compatible upstreams.
- Quota: `GET {root}/api/governance/virtual-keys/quota`. This is self-service, authenticated by the VK alone, and returns `budgets[]` plus `rate_limits[]`. Counters are kept in memory and written to the database **every ~10 s**, and the endpoint reads the database. Wait at least 10 s after traffic before asserting on counts.
- Source of truth for shapes: `core/schemas/models.go` (`Model`) and `transports/bifrost-http/handlers/governance.go` (`getVirtualKeyQuota`) in maximhq/bifrost.
- Prompt caching passes through: an OpenAI-format content part's `cache_control` becomes an Anthropic block's `cache_control` (`core/providers/anthropic/chat.go`) or a Bedrock cache point (`core/providers/bedrock/chat.go`). Responses report `prompt_tokens_details.cached_tokens` (reads) and `cache_write_tokens` (writes), which omp parses and prices.
- Anthropic route: `{root}/anthropic/v1/messages` and `/anthropic/v1/models` are built into Bifrost (no toggle). The model id may keep its `anthropic/` prefix; Bifrost parses it. Virtual keys work as `x-api-key`. On inference, every VK header (`x-bf-vk`, `Authorization: Bearer`, `x-api-key`, …) must start with `sk-bf-` (`plugins/governance/utils.go`); only the quota endpoint accepts any `x-bf-vk` value. Requests with a Claude Code user-agent take Bifrost's passthrough path (raw body forwarded). `cache_control.ttl` is preserved.

## Testing end to end

`test/fixture/run.sh` starts `test/fixture/mock-openai.ts`, which serves an OpenAI API at `/v1` (4 models, one deliberately unknown, `acme-mystery-1`) and an Anthropic Messages API at `/anthropic/v1` (`claude-sonnet-5-5`). The Anthropic mock logs `ANTHROPIC_CACHE_CONTROL present|absent` per request and simulates caching: the first marked request reports a cache write, later ones a cache read. `run.sh` also starts a real Bifrost via `npx -y @maximhq/bifrost` using `test/fixture/app/config.json`. That config routes `openai` and `anthropic` to the mocks and sets virtual key `sk-bf-omp-test-0000000000000000` with a $5/day budget and hourly token and request limits. No real provider keys are needed. No container runtime is required; the npm package runs the native binary.

Behind Bifrost's Anthropic route the same mock receives native requests; `BIFROST_ANTHROPIC_ROUTE=off` exercises the chat-completions path for Claude.

**Isolate omp from the user's real config** with a throwaway agent dir. Otherwise discovery and the model cache write into `~/.omp`:

```bash
export PI_CODING_AGENT_DIR=$(mktemp -d) BIFROST_URL=http://127.0.0.1:18080 BIFROST_VIRTUAL_KEY=sk-bf-omp-test-0000000000000000
omp --no-extensions -e ./src/index.ts -p --model bifrost/openai/gpt-4o-mini "say ping"   # expect "pong from mock (gpt-4o-mini)"
omp usage --no-extensions -e ./src/index.ts -p bifrost
```

Gotchas:

- With an empty agent dir, omp has no other models, so its own background calls (e.g. skill-description summaries) also route through `bifrost`. That's expected; they only reach the mock.
- `omp models <provider>` does not load `-e` extensions. Use `omp usage -e …` or a `-p` prompt to exercise the extension.
- Bifrost writes `*.db` files into `test/fixture/app/`. They are gitignored, and `run.sh` deletes them on start.
- Stop the fixture with Ctrl+C, or `pkill -f "bifrost.*-port 18080"; pkill -f "bun mock-openai.ts"`.
- **Not covered by automation:** `/login bifrost` and `/bifrost status|refresh`, which are interactive TUI flows.

## Behavior to preserve

- **Bearer choice** (`bearerKeyConfig`): `BIFROST_API_KEY` (env name), then `BIFROST_VIRTUAL_KEY` (env name), then the saved VK, then the `bifrost-keyless` placeholder. Never send the placeholder when a VK is available.
- **Config precedence:** env vars override `<agentDir>/bifrost.json` (written by `/login`, mode 600, holds URL and VK only). The API key from `/login` lives in omp's credential store.
- **Metadata precedence:** Bifrost-reported values, then omp's bundled catalog (`createCatalogLookup`, with provider aliases such as `gemini→google`), then the 128k/16k defaults with a one-time warning.
- **Claude caching:** every model whose id matches `/claude/i` gets `cacheControlFormat: "anthropic"`; nothing else does. Changing what models get must bump `CATALOG_VERSION`.
- **Claude route:** `anthropic/claude-*` use the native transport at `{root}/anthropic` when the discovery-time probe of `/anthropic/v1/models` returns 200 and `anthropicRoute` isn't `off`; otherwise the chat-completions mapping above. Bedrock/Vertex Claude always use chat completions until verified. `/login` must preserve `anthropicRoute` in `bifrost.json`.
- **Usage never errors:** every failure path in `src/usage.ts` returns `null`. Keep it that way. A provider that can't read quota must look exactly like one with no limits.

## Releasing

Follow semver for `0.x`: patch for fixes, minor for user-visible features.

1. Bump `version` in `package.json` and commit as `Release X.Y.Z`.
2. `git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"`, then `git push && git push origin vX.Y.Z`.
3. `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>`. Notes are written for users: what changed, how to upgrade, and a compare link.

Users install with `omp install github:aljopro/omp-bifrost-provider[#vX.Y.Z]`; nothing is published to npm yet. They update with `omp plugin upgrade @jensenchappell/omp-bifrost-provider`. `omp update --plugins` only upgrades **marketplace** plugins and silently skips git/npm installs (verified in omp 18.20, `cli/plugin-cli.ts` `handleUpgrade`).

To test install/upgrade flows without touching the real `~/.omp`, run omp with `HOME` pointed at a fresh `mktemp -d` folder; the plugins dir follows `HOME`. Never `rm -rf "$HOME"` after reassigning it.

**Package name:** `@jensenchappell/omp-bifrost-provider`, scoped to the owner's npm account so a future npm publish needs no rename. Never rename it back to bare `omp-bifrost-provider`. That name belongs to an unrelated npm package (a separate omp port, publisher "mcnull"). omp tracks plugins by package name, so a matching bare name made reinstalls and upgrades keep resolving npm's 0.1.0 instead of this repo.

**Renaming the package is a breaking move for installed users.** `omp plugin upgrade` across a name change installs the new code but leaves the bun dependency key under the old name, while omp's plugin record takes the new one. After that, uninstall by either name and upgrade by the new name all fail. Tell users to `omp plugin uninstall <old>` *before* installing; recovery is `(cd ~/.omp/plugins && bun remove <old>)` and a reinstall. Both routes were verified in an isolated HOME for 0.2.0 → 0.2.1.

## Style

- TypeScript, ESM, tabs, double quotes. Strict `tsc`. Explicit `.ts` import suffixes.
- Comments explain *why* (omp or Bifrost quirks), not what.
- Keep the README's user-facing docs in sync when behavior or config changes.
