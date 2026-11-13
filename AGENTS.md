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

## omp facts (verified against omp 18.20 source, not obvious from docs)

- **Imports.** `@oh-my-pi/pi-ai`, `pi-catalog`, `pi-coding-agent`, `pi-utils` and `pi-tui` resolve to the copies bundled inside the omp binary at runtime. They are devDependencies here only for types. Don't add runtime deps on them.
- **`registerProvider(name, config)`** (`ProviderConfig` in `pi-coding-agent` `extensibility/extensions/types.ts`):
  - `apiKey` is an env-var *name* or a literal. With `oauth` set, it is only a fallback: a key saved by `/login` wins.
  - `fetchDynamicModels(apiKey)` goes through omp's SQLite model cache (24 h TTL). Returning `models` alongside it keeps them as static fallbacks.
  - Calling `registerProvider` again replaces the registration. That is how `/login` and `/bifrost refresh` push new models immediately.
- **Headers.** omp always sends `Authorization: Bearer <apiKey>`, and an extension cannot remove or null it. `before_provider_request` can rewrite only the body. Per-request headers (e.g. `x-bf-session-id`) would need a custom `streamSimple` wrapping the built-in transport. That is deliberately not done, because a custom `api` id loses openai-completions-specific handling elsewhere in omp.
- **Usage hook.** `usage: UsageProvider`. With `usesRequestKey: true`, omp probes with exactly the key inference sends. A `null` result means "no data" and triggers a `failureBackoffMs` cooldown, which is how unsupported gateways stay quiet.
- **Notifications.** Use `ctx.ui.notify` only after `session_start`, and queue anything earlier. Writing to stdout or stderr while the TUI owns the terminal garbles it. In non-TTY (`-p`) runs, stderr is fine.
- **Thinking.** Use `{ mode: "effort", efforts: [...] }`. Valid efforts are `minimal|low|medium|high|xhigh|max`; omp sends the effort as `reasoning_effort`.

## Bifrost facts (verified against a real gateway)

- Native OpenAI-compatible API: `{root}/v1/models`, `{root}/v1/chat/completions`. The `/openai/v1` integration route also works. Model ids are `provider/model`.
- Governance is on by default. Once virtual keys exist, inference needs one.
- A virtual key is accepted via `x-bf-vk` **or** as `Authorization: Bearer sk-bf-…`. A non-VK bearer next to `x-bf-vk` is ignored unless `allow_direct_keys` is enabled.
- `/v1/models` often includes `context_length`, `max_output_tokens`, `pricing` (USD **per token**, as strings) and `reasoning.supported_efforts`. It often omits them for OpenAI-compatible upstreams.
- Quota: `GET {root}/api/governance/virtual-keys/quota`. This is self-service, authenticated by the VK alone, and returns `budgets[]` plus `rate_limits[]`. Counters are kept in memory and written to the database **every ~10 s**, and the endpoint reads the database. Wait at least 10 s after traffic before asserting on counts.
- Source of truth for shapes: `core/schemas/models.go` (`Model`) and `transports/bifrost-http/handlers/governance.go` (`getVirtualKeyQuota`) in maximhq/bifrost.

## Testing end to end

`test/fixture/run.sh` starts `test/fixture/mock-openai.ts`, which serves 4 models (one deliberately unknown, `acme-mystery-1`), and a real Bifrost via `npx -y @maximhq/bifrost` using `test/fixture/app/config.json`. That config sets virtual key `sk-bf-omp-test-0000000000000000` with a $5/day budget and hourly token and request limits. No real provider keys are needed. No container runtime is required; the npm package runs the native binary.

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
- **Usage never errors:** every failure path in `src/usage.ts` returns `null`. Keep it that way. A provider that can't read quota must look exactly like one with no limits.

## Releasing

Follow semver for `0.x`: patch for fixes, minor for user-visible features.

1. Bump `version` in `package.json` and commit as `Release X.Y.Z`.
2. `git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"`, then `git push && git push origin vX.Y.Z`.
3. `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>`. Notes are written for users: what changed, how to upgrade, and a compare link.

Users install with `omp install github:aljopro/omp-bifrost-provider[#vX.Y.Z]`; nothing is published to npm yet.

**Package name:** `@jensenchappell/omp-bifrost-provider`, scoped to the owner's npm account so a future npm publish needs no rename. Never rename it back to bare `omp-bifrost-provider`. That name belongs to an unrelated npm package (a separate omp port, publisher "mcnull"). omp tracks plugins by package name, so a matching bare name made `omp update --plugins` keep resolving npm's 0.1.0 instead of this repo.

## Style

- TypeScript, ESM, tabs, double quotes. Strict `tsc`. Explicit `.ts` import suffixes.
- Comments explain *why* (omp or Bifrost quirks), not what.
- Keep the README's user-facing docs in sync when behavior or config changes.
