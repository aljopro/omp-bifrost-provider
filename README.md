# omp-bifrost-provider

An [oh-my-pi](https://omp.sh) (omp) provider for the [Bifrost AI Gateway](https://www.getmaxim.ai/bifrost). It discovers models from Bifrost and sends requests through Bifrost's OpenAI-compatible Chat Completions API.

Every model Bifrost exposes (`openai/gpt-4o`, `anthropic/claude-sonnet-5-5`, `gemini/...`, …) shows up in omp as `bifrost/<provider>/<model>`, usable anywhere omp takes a model: `/model`, `--model`, `modelRoles`, retry fallback chains.

## Install

```bash
omp install github:aljopro/omp-bifrost-provider
```

To update, upgrade it by name, then restart omp:

```bash
omp plugin upgrade @jensenchappell/omp-bifrost-provider
```

Neither `omp update` (omp itself) nor `omp update --plugins` (marketplace plugins only) touches GitHub-installed plugins.

### Coming from `omp-bifrost-provider` (unscoped)

Since 0.2.1 the package is named `@jensenchappell/omp-bifrost-provider`. The unscoped `omp-bifrost-provider` on npm is an **unrelated** port by a different publisher. Releases of this repo before 0.2.1 also used that bare name.

If you have the bare name installed, from npm or from this repo, uninstall it first. **Don't** `omp plugin upgrade` across the rename; omp's records end up split between the two names.

```bash
omp plugin uninstall omp-bifrost-provider
omp install github:aljopro/omp-bifrost-provider
```

If you already upgraded, so that `omp plugin list` shows the new name but uninstall says "not installed", clear the leftover entry and reinstall:

```bash
(cd ~/.omp/plugins && bun remove omp-bifrost-provider)
omp install github:aljopro/omp-bifrost-provider
```

Coming from the npm port, run `/login bifrost` again afterwards; the two store logins in different formats.

Or try it for one session from a checkout:

```bash
omp -e ./src/index.ts
```

Extensions run with your user's permissions. Read `src/` before installing; it's two files.

## Configure

### Interactive

```text
/login bifrost
```

omp prompts for:

1. **Bifrost URL** — e.g. `http://localhost:8080`
2. **API key** — optional
3. **Virtual key** — optional

The login checks the gateway by listing its models. The URL and virtual key are saved to `~/.omp/agent/bifrost.json` (mode `600`); the API key goes into omp's credential store.

### Environment

| Variable | Required | Description |
| --- | --- | --- |
| `BIFROST_URL` | yes* | Gateway URL, e.g. `http://localhost:8080`. |
| `BIFROST_API_KEY` | no | Sent as `Authorization: Bearer …`. |
| `BIFROST_VIRTUAL_KEY` | no | Governance virtual key, sent as `x-bf-vk`. |

\* Either `BIFROST_URL` or a prior `/login bifrost`. Environment variables override the saved login.

### URLs

The URL is normalized to Bifrost's OpenAI-compatible base:

| You give | Used |
| --- | --- |
| `http://localhost:8080` | `http://localhost:8080/v1` |
| `http://localhost:8080/openai` | `http://localhost:8080/openai/v1` (OpenAI integration route) |
| `https://gw.example.com/bifrost/v1` | unchanged (reverse-proxy mounts) |

Discovery hits `{base}/models`; inference hits `{base}/chat/completions`.

### Auth combinations

omp always sends an `Authorization: Bearer` header and extensions can't remove it, so the provider picks the most meaningful bearer it has:

- **Virtual key only** — the common Bifrost setup, and all you need unless your admins added a separate auth layer. The virtual key is sent both as `x-bf-vk` and as the bearer (Bifrost accepts either), so nothing fake ever reaches the gateway.
- **API key only** — Bearer auth.
- **Both** — API key as the bearer, plus `x-bf-vk`.
- **Neither** — keyless gateway. A placeholder bearer (`bifrost-keyless`) is sent, which open gateways ignore. If yours has direct provider keys enabled (`allow_direct_keys`), configure a virtual key instead.

## Commands

- `/bifrost status` — URL and where it came from, which key is in use, catalog state.
- `/bifrost refresh` — re-fetch the model list now (otherwise omp caches it for 24 h).

## Usage and limits

If your virtual key has budgets or rate limits, they show up in omp's `/usage` (and `omp usage`) next to your other providers:

```text
Bifrost — 1 account
  ● my-team-key
      ● Monthly budget     ███████████░░░░░░░░░░░░░░░░░  $42.50 / $100.00 · 42.5% used · resets in 17d
      ● Tokens (hourly)    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  600 / 200K tokens · 0.3% used · resets in 59m
      ● Requests (hourly)  ███████████░░░░░░░░░░░░░░░░░  40 / 100 requests · 40.0% used · resets in 59m
```

The same numbers feed omp's usage-aware fallback (`retry.usageAwareFallback`), so omp can move to your fallback chain *before* a Bifrost limit is hit rather than after a failed request.

This reads Bifrost's self-service quota endpoint, `GET /api/governance/virtual-keys/quota`, authenticated by the virtual key alone (no admin access). Bifrost saves counters about every 10 seconds, so the newest requests can lag.

It stays silent — no errors, nothing shown — when:

- there's no virtual key (an API key alone can't read quota),
- the key has no budgets or rate limits,
- the gateway is too old to have the endpoint, or a proxy only exposes `/v1` and not `/api` (404/401/403).

omp then waits 10 minutes before asking again. To check what your gateway returns:

```bash
curl -s -H "x-bf-vk: $BIFROST_VIRTUAL_KEY" https://bifrost.example.com/api/governance/virtual-keys/quota
```

## Model metadata

Bifrost's `/v1/models` often includes context length, output limit, pricing (USD/token, converted to USD/million) and reasoning efforts. Whatever it reports wins. When it omits something — common for OpenAI-compatible upstreams — the provider fills the gap from **omp's own bundled model catalog** (`@oh-my-pi/pi-catalog`), matching `anthropic/claude-…` against omp's `anthropic` entries, `gemini/…` against `google`, and so on, then falling back to OpenRouter's `vendor/model` ids. Anything still unknown gets 128k context / 16k output, and omp shows a one-time warning naming those models so the guess isn't silent.

Reasoning models get an omp `effort` thinking ladder from Bifrost's `supported_efforts` (or the catalog), which omp sends as `reasoning_effort` — Bifrost translates that for non-OpenAI upstreams.

To pin exact numbers for one model, use `modelOverrides` in `~/.omp/agent/models.yml`:

```yaml
providers:
  bifrost:
    modelOverrides:
      anthropic/claude-opus-5-5:
        contextWindow: 1000000
        maxTokens: 128000
```

Embedding, TTS, transcription, image and moderation models are filtered out.

## Differences from pi-bifrost-provider

This is a port of the idea behind [pi-bifrost-provider](https://github.com/lxdlam/pi-bifrost-provider) to omp's extension API, not a fork:

- Uses omp's `registerProvider` + `fetchDynamicModels`, so discovery goes through omp's SQLite model cache like built-in providers.
- Fills missing limits from omp's bundled catalog instead of downloading models.dev.
- Reports virtual-key budgets and rate limits to omp's `/usage` and usage-aware fallback (pi-bifrost-provider has no usage reporting).
- Defaults to Bifrost's native `/v1` API rather than the `/openai/v1` integration route (both work).
- Does **not** yet send `x-bf-session-id`: omp's extension API only lets an extension rewrite the request body, not per-request headers, without replacing omp's OpenAI transport. Bifrost logs still work; they just aren't grouped by omp session.

## Develop

```bash
bun install
bun run check   # tsc
bun test        # unit tests
```

### Against a real gateway

`test/fixture/run.sh` starts a mock OpenAI upstream on `:18081` and a real Bifrost (`npx @maximhq/bifrost`) on `:18080` routed to it, with a test virtual key that has a $5 daily budget and hourly token/request limits. No provider API keys needed:

```bash
./test/fixture/run.sh
```

Then in another shell:

```bash
BIFROST_TEST_URL=http://127.0.0.1:18080 BIFROST_TEST_VK=sk-bf-omp-test-0000000000000000 bun test
BIFROST_URL=http://127.0.0.1:18080 BIFROST_VIRTUAL_KEY=sk-bf-omp-test-0000000000000000 \
  omp -e ./src/index.ts -p --model bifrost/openai/gpt-4o-mini "say ping"
BIFROST_URL=http://127.0.0.1:18080 BIFROST_VIRTUAL_KEY=sk-bf-omp-test-0000000000000000 \
  omp usage -e ./src/index.ts -p bifrost
```

Bifrost's UI is at http://127.0.0.1:18080 while it runs — the request logs show traffic from omp.

## License

MIT
