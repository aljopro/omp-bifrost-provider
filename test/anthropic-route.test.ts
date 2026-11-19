import { describe, expect, test } from "bun:test";
import {
	type AnthropicRouteState,
	type BifrostConfig,
	fetchBifrostModels,
	isNativeAnthropicId,
	resolveConfig,
	toModelConfig,
} from "../src/index.ts";

const base = "http://gw/v1";
const native = "http://gw/anthropic";
const hint = () => ({ contextWindow: 1_000_000, maxTokens: 128_000, nativeThinking: { mode: "anthropic-adaptive", efforts: ["low", "high"] as never } });

describe("isNativeAnthropicId", () => {
	test.each([
		["anthropic/claude-sonnet-5-5", true],
		["Anthropic/Claude-Haiku-5-5", true],
		["bedrock/us.anthropic.claude-haiku-5-5", false],
		["vertex/claude-opus-5-5", false],
		["openai/gpt-4o", false],
	])("%s -> %s", (id, expected) => expect(isNativeAnthropicId(id)).toBe(expected));
});

describe("toModelConfig with the Anthropic route", () => {
	test("anthropic/claude-* switch to the native transport", () => {
		const m = toModelConfig({ id: "anthropic/claude-sonnet-5-5" }, base, hint, undefined, native) as unknown as Record<string, unknown>;
		expect(m.api).toBe("anthropic-messages");
		expect(m.baseUrl).toBe(native);
		expect(m.id).toBe("anthropic/claude-sonnet-5-5");
		expect(m.compat).toEqual({ supportsLongCacheRetention: true });
		expect(m.thinking).toEqual({ mode: "anthropic-adaptive", efforts: ["low", "high"] });
		expect(m.contextWindow).toBe(1_000_000);
	});

	test("without native thinking in the catalog, no thinking ladder is promised", () => {
		const m = toModelConfig({ id: "anthropic/claude-x", reasoning: { supported_efforts: ["low"] } }, base, undefined, undefined, native) as unknown as Record<string, unknown>;
		expect(m.api).toBe("anthropic-messages");
		expect(m.thinking).toBeUndefined();
	});

	test("Bedrock Claude stays on chat completions, with cache markers", () => {
		const m = toModelConfig({ id: "bedrock/us.anthropic.claude-haiku-5-5" }, base, undefined, undefined, native) as Record<string, any>;
		expect(m.api).toBe("openai-completions");
		expect(m.baseUrl).toBe(base);
		expect(m.compat.cacheControlFormat).toBe("anthropic");
	});

	test("no route: Claude keeps the 0.2.2 chat-completions mapping", () => {
		const m = toModelConfig({ id: "anthropic/claude-sonnet-5-5" }, base) as Record<string, any>;
		expect(m.api).toBe("openai-completions");
		expect(m.compat.cacheControlFormat).toBe("anthropic");
	});
});

describe("route detection during discovery", () => {
	const config: BifrostConfig = { baseUrl: "http://gw/v1", virtualKey: "sk-bf-vk", source: "env", anthropicRoute: "auto" };
	const listing = { data: [{ id: "anthropic/claude-sonnet-5-5" }, { id: "openai/gpt-4o" }] };

	const run = async (probeStatus: number, cfg: BifrostConfig = config, data = listing) => {
		const calls: { url: string; headers: Headers }[] = [];
		let route: AnthropicRouteState | undefined;
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url, headers: new Headers(init?.headers) });
			if (url.endsWith("/anthropic/v1/models")) return new Response("{}", { status: probeStatus });
			return Response.json(data);
		}) as unknown as typeof fetch;
		const models = await fetchBifrostModels(cfg, undefined, { fetch: fakeFetch, onAnthropicRoute: r => { route = r; } });
		const claude = models.find(m => m.id === "anthropic/claude-sonnet-5-5") as unknown as Record<string, unknown> | undefined;
		const gpt = models.find(m => m.id === "openai/gpt-4o") as unknown as Record<string, unknown> | undefined;
		return { calls, route, claude, gpt };
	};

	test("route open: Claude goes native, others unchanged, probe authenticates like omp will", async () => {
		const { calls, route, claude, gpt } = await run(200);
		expect(route).toEqual({ kind: "native", baseUrl: "http://gw/anthropic" });
		expect(claude?.api).toBe("anthropic-messages");
		expect(gpt?.api).toBe("openai-completions");
		const probe = calls.find(c => c.url === "http://gw/anthropic/v1/models")!;
		expect(probe.headers.get("x-api-key")).toBe("sk-bf-vk");
		expect(probe.headers.get("x-bf-vk")).toBe("sk-bf-vk");
	});

	test.each([404, 401, 403, 500])("route answers %i: stay on chat completions", async status => {
		const { route, claude } = await run(status);
		expect(route).toEqual({ kind: "unavailable", reason: `HTTP ${status}` });
		expect(claude?.api).toBe("openai-completions");
	});

	test("anthropicRoute off: no probe at all", async () => {
		const { calls, route, claude } = await run(200, { ...config, anthropicRoute: "off" });
		expect(route).toEqual({ kind: "off" });
		expect(calls.some(c => c.url.includes("/anthropic/"))).toBe(false);
		expect(claude?.api).toBe("openai-completions");
	});

	test("no anthropic/claude models listed: no probe", async () => {
		const { calls, route } = await run(200, config, { data: [{ id: "openai/gpt-4o" }] });
		expect(route).toEqual({ kind: "unused" });
		expect(calls.some(c => c.url.includes("/anthropic/"))).toBe(false);
	});

	test("probe uses the gateway root even for an /openai/v1 base", async () => {
		const { calls } = await run(200, { ...config, baseUrl: "http://gw/openai/v1" });
		expect(calls.some(c => c.url === "http://gw/anthropic/v1/models")).toBe(true);
	});
});

describe("anthropicRoute setting", () => {
	test.each([
		[undefined, "auto"],
		["off", "off"],
		["FALSE", "off"],
		["auto", "auto"],
		["bogus", "auto"],
	])("BIFROST_ANTHROPIC_ROUTE=%s -> %s", async (value, expected) => {
		const cfg = await resolveConfig({ BIFROST_URL: "http://gw", ...(value ? { BIFROST_ANTHROPIC_ROUTE: value } : {}) });
		expect(cfg?.anthropicRoute).toBe(expected as never);
	});
});
