import { describe, expect, test } from "bun:test";
import {
	type BifrostConfig,
	bearerKeyConfig,
	fetchBifrostModels,
	KEYLESS_PLACEHOLDER,
	normalizeBaseUrl,
	toModelConfig,
} from "../src/index.ts";

describe("bearerKeyConfig", () => {
	const cfg: BifrostConfig = { baseUrl: "http://gw/v1", virtualKey: "sk-bf-from-file", source: "file" };
	test("API key env var wins, passed by name", () => {
		expect(bearerKeyConfig(cfg, { BIFROST_API_KEY: "k", BIFROST_VIRTUAL_KEY: "vk" })).toBe("BIFROST_API_KEY");
	});
	test("virtual key env var next, passed by name", () => {
		expect(bearerKeyConfig(cfg, { BIFROST_VIRTUAL_KEY: "vk" })).toBe("BIFROST_VIRTUAL_KEY");
	});
	test("saved virtual key next", () => {
		expect(bearerKeyConfig(cfg, {})).toBe("sk-bf-from-file");
	});
	test("placeholder only when there is nothing else", () => {
		expect(bearerKeyConfig({ ...cfg, virtualKey: undefined }, {})).toBe(KEYLESS_PLACEHOLDER);
		expect(bearerKeyConfig(undefined, {})).toBe(KEYLESS_PLACEHOLDER);
	});
});

describe("normalizeBaseUrl", () => {
	test.each([
		["http://localhost:8080", "http://localhost:8080/v1"],
		["http://localhost:8080/", "http://localhost:8080/v1"],
		["http://localhost:8080/v1", "http://localhost:8080/v1"],
		["http://localhost:8080/openai", "http://localhost:8080/openai/v1"],
		["http://localhost:8080/openai/v1/", "http://localhost:8080/openai/v1"],
		["https://gw.example.com/bifrost/v1/chat/completions", "https://gw.example.com/bifrost/v1"],
		["https://gw.example.com/v1/models", "https://gw.example.com/v1"],
	])("%s -> %s", (input, expected) => {
		expect(normalizeBaseUrl(input)).toBe(expected);
	});

	test("rejects junk", () => {
		expect(() => normalizeBaseUrl("not a url")).toThrow();
		expect(() => normalizeBaseUrl("ftp://host")).toThrow();
		expect(() => normalizeBaseUrl("http://host/v1?x=1")).toThrow();
	});
});

describe("toModelConfig", () => {
	const base = "http://gw/v1";

	test("maps Bifrost metadata and per-token pricing", () => {
		const m = toModelConfig(
			{
				id: "openai/gpt-4o",
				normalized_name: "Gpt 4O",
				context_length: 128000,
				max_input_tokens: 128000,
				max_output_tokens: 16384,
				pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000125" },
				architecture: { input_modalities: ["text", "image"] },
			},
			base,
		);
		expect(m).toMatchObject({
			id: "openai/gpt-4o",
			name: "Gpt 4O",
			api: "openai-completions",
			contextWindow: 128000,
			maxTokens: 16384,
			input: ["text", "image"],
			reasoning: false,
		});
		expect(m?.cost.input).toBeCloseTo(2.5);
		expect(m?.cost.output).toBeCloseTo(10);
		expect(m?.cost.cacheRead).toBeCloseTo(1.25);
	});

	test("reasoning efforts become an effort ladder", () => {
		const m = toModelConfig(
			{ id: "openai/o4-mini", reasoning: { supported_efforts: ["low", "medium", "high", "bogus"], default_effort: "medium" } },
			base,
		);
		expect(m?.reasoning).toBe(true);
		expect(m?.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" } as never);
	});

	test("falls back to catalog hint, then defaults", () => {
		const hinted = toModelConfig({ id: "anthropic/claude-x" }, base, () => ({ contextWindow: 1_000_000, maxTokens: 64_000 }));
		expect(hinted).toMatchObject({ contextWindow: 1_000_000, maxTokens: 64_000 });
		const bare = toModelConfig({ id: "x/unknown" }, base);
		expect(bare).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
	});

	test("drops non-chat models", () => {
		expect(toModelConfig({ id: "openai/text-embedding-3-small" }, base)).toBeUndefined();
		expect(toModelConfig({ id: "openai/whisper-1" }, base)).toBeUndefined();
		expect(toModelConfig({ id: "x/foo", supported_methods: ["embedding"] }, base)).toBeUndefined();
		expect(toModelConfig({ id: "x/foo", supported_methods: ["chat_completion"] }, base)).toBeDefined();
	});
});

describe("fetchBifrostModels", () => {
	const config: BifrostConfig = { baseUrl: "http://gw/v1", virtualKey: "sk-bf-vk", source: "env" };

	test("sends auth headers, dedupes, sorts", async () => {
		let seen: Headers | undefined;
		const fakeFetch = (async (_url: string, init?: RequestInit) => {
			seen = new Headers(init?.headers);
			return Response.json({ data: [{ id: "b/m" }, { id: "a/m" }, { id: "a/m" }] });
		}) as unknown as typeof fetch;
		const models = await fetchBifrostModels(config, "real-key", { fetch: fakeFetch });
		expect(models.map(m => m.id)).toEqual(["a/m", "b/m"]);
		expect(seen?.get("authorization")).toBe("Bearer real-key");
		expect(seen?.get("x-bf-vk")).toBe("sk-bf-vk");
	});

	test("keyless placeholder is never sent as a bearer", async () => {
		let seen: Headers | undefined;
		const fakeFetch = (async (_u: string, init?: RequestInit) => {
			seen = new Headers(init?.headers);
			return Response.json({ data: [{ id: "a/m" }] });
		}) as unknown as typeof fetch;
		await fetchBifrostModels(config, "bifrost-keyless", { fetch: fakeFetch });
		expect(seen?.has("authorization")).toBe(false);
	});

	test("reports models left on default limits", async () => {
		const fakeFetch = (async () =>
			Response.json({
				data: [{ id: "x/known", context_length: 32000 }, { id: "x/unknown-b" }, { id: "x/unknown-a" }],
			})) as unknown as typeof fetch;
		let reported: string[] = [];
		await fetchBifrostModels(config, undefined, {
			fetch: fakeFetch,
			catalog: () => undefined,
			onDefaultLimits: ids => {
				reported = ids;
			},
		});
		expect(reported).toEqual(["x/unknown-a", "x/unknown-b"]);
	});

	test("catalog hint suppresses the default-limits report", async () => {
		const fakeFetch = (async () => Response.json({ data: [{ id: "x/m" }] })) as unknown as typeof fetch;
		let called = false;
		await fetchBifrostModels(config, undefined, {
			fetch: fakeFetch,
			catalog: () => ({ contextWindow: 200_000 }),
			onDefaultLimits: () => {
				called = true;
			},
		});
		expect(called).toBe(false);
	});

	test("surfaces Bifrost error messages", async () => {
		const fakeFetch = (async () =>
			Response.json({ error: { message: "virtual key is required" } }, { status: 401 })) as unknown as typeof fetch;
		await expect(fetchBifrostModels(config, undefined, { fetch: fakeFetch })).rejects.toThrow(
			"Bifrost model discovery failed (401): virtual key is required",
		);
	});

	const live = process.env.BIFROST_TEST_URL;
	test.skipIf(!live)("live gateway", async () => {
		const models = await fetchBifrostModels(
			{ baseUrl: normalizeBaseUrl(live!), virtualKey: process.env.BIFROST_TEST_VK, source: "env" },
			undefined,
		);
		expect(models.length).toBeGreaterThan(0);
		expect(models[0]!.id).toContain("/");
	});
});
