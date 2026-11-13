import { describe, expect, test } from "bun:test";
import {
	type BifrostQuota,
	createBifrostUsageProvider,
	gatewayRoot,
	nextReset,
	parsePeriod,
	quotaToReport,
} from "../src/usage.ts";

describe("gatewayRoot", () => {
	test.each([
		["http://gw:8080/v1", "http://gw:8080"],
		["http://gw:8080/openai/v1", "http://gw:8080"],
		["https://corp.example.com/bifrost/v1", "https://corp.example.com/bifrost"],
	])("%s -> %s", (input, expected) => expect(gatewayRoot(input)).toBe(expected));
});

describe("periods", () => {
	test("parses Bifrost durations, M is month and m is minute", () => {
		expect(parsePeriod("5m")).toEqual({ count: 5, unit: "m" });
		expect(parsePeriod("1M")).toEqual({ count: 1, unit: "M" });
		expect(parsePeriod("bogus")).toBeUndefined();
		expect(parsePeriod("0h")).toBeUndefined();
	});
	test("next reset uses calendar months", () => {
		expect(nextReset("2026-01-31T00:00:00Z", { count: 1, unit: "d" })).toBe(Date.parse("2026-02-01T00:00:00Z"));
		expect(nextReset("2026-11-01T00:00:00Z", { count: 1, unit: "M" })).toBe(Date.parse("2026-12-01T00:00:00Z"));
		expect(nextReset("2026-01-01T00:00:00Z", { count: 1, unit: "Q" })).toBe(Date.parse("2026-04-01T00:00:00Z"));
		expect(nextReset(undefined, { count: 1, unit: "d" })).toBeUndefined();
	});
});

const quota: BifrostQuota = {
	virtual_key_name: "omp-test",
	is_active: true,
	budgets: [
		{ id: "b1", max_limit: 50, current_usage: 42.5, reset_duration: "1M", last_reset: "2026-11-01T00:00:00Z" },
		{ id: "b-unlimited", max_limit: 0, current_usage: 3 },
	],
	rate_limit: { id: "rl", token_max_limit: 200_000, token_current_usage: 10_000, token_reset_duration: "1h" },
	rate_limits: [
		{
			id: "rl",
			token_max_limit: 200_000,
			token_current_usage: 10_000,
			token_reset_duration: "1h",
			token_last_reset: "2026-11-13T12:00:00Z",
			request_max_limit: 100,
			request_current_usage: 100,
			request_reset_duration: "1h",
			request_last_reset: "2026-11-13T12:00:00Z",
		},
	],
};

describe("quotaToReport", () => {
	const report = quotaToReport(quota, "bifrost", 1)!;

	test("maps budget, tokens and requests; skips zero limits; dedupes rate_limit", () => {
		expect(report.limits.map(l => l.id)).toEqual(["budget:b1", "tokens:rl", "requests:rl"]);
	});

	test("budget in USD with monthly window and status", () => {
		const budget = report.limits[0]!;
		expect(budget.label).toBe("Monthly budget");
		expect(budget.amount).toMatchObject({ used: 42.5, limit: 50, remaining: 7.5, unit: "usd" });
		expect(budget.amount.usedFraction).toBeCloseTo(0.85);
		expect(budget.status).toBe("warning");
		expect(budget.window?.resetsAt).toBe(Date.parse("2026-12-01T00:00:00Z"));
		expect(budget.scope).toEqual({ provider: "bifrost", accountId: "omp-test" });
	});

	test("rate limits with hourly windows", () => {
		const [, tokens, requests] = report.limits;
		expect(tokens).toMatchObject({ label: "Tokens (hourly)", status: "ok" });
		expect(tokens!.window).toMatchObject({ durationMs: 3_600_000, resetsAt: Date.parse("2026-11-13T13:00:00Z") });
		expect(requests).toMatchObject({ label: "Requests (hourly)", status: "exhausted" });
	});

	test("no limits means no report", () => {
		expect(quotaToReport({ is_active: true, budgets: [], rate_limits: [] }, "bifrost")).toBeNull();
	});

	test("inactive key is reported, everything exhausted", () => {
		const r = quotaToReport({ ...quota, is_active: false }, "bifrost")!;
		expect(r.notes?.[0]).toContain("inactive");
		expect(r.limits.every(l => l.status === "exhausted")).toBe(true);
	});
});

describe("usage provider", () => {
	const config = { baseUrl: "http://gw/openai/v1", virtualKey: "sk-bf-configured" };
	const run = async (
		fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
		opts: { cfg?: typeof config | undefined; requestKey?: string } = {},
	) => {
		const provider = createBifrostUsageProvider("bifrost", {
			resolve: async () => ("cfg" in opts ? opts.cfg : config),
		});
		return provider.fetchUsage(
			{ provider: "bifrost", credential: { type: "api_key", apiKey: opts.requestKey } } as never,
			{ fetch: fetchImpl as never },
		);
	};

	test("calls the quota endpoint at the gateway root with the virtual key", async () => {
		let url = "";
		let vk = null as string | null;
		const report = await run(async (u, init) => {
			url = u;
			vk = new Headers(init?.headers).get("x-bf-vk");
			return Response.json(quota);
		});
		expect(url).toBe("http://gw/api/governance/virtual-keys/quota");
		expect(vk).toBe("sk-bf-configured");
		expect(report?.limits.length).toBe(3);
	});

	test("falls back to the request key when it is a virtual key", async () => {
		let vk = null as string | null;
		await run(
			async (_u, init) => {
				vk = new Headers(init?.headers).get("x-bf-vk");
				return Response.json(quota);
			},
			{ cfg: { baseUrl: "http://gw/v1" } as typeof config, requestKey: "sk-bf-from-request" },
		);
		expect(vk).toBe("sk-bf-from-request");
	});

	test("no virtual key anywhere: no request, no report", async () => {
		let called = false;
		const report = await run(
			async () => {
				called = true;
				return Response.json(quota);
			},
			{ cfg: { baseUrl: "http://gw/v1" } as typeof config, requestKey: "plain-api-key" },
		);
		expect(called).toBe(false);
		expect(report).toBeNull();
	});

	test.each([404, 401, 403, 500])("HTTP %i is quietly null", async status => {
		expect(await run(async () => new Response("nope", { status }))).toBeNull();
	});

	test("network errors are quietly null", async () => {
		expect(
			await run(async () => {
				throw new Error("ECONNREFUSED");
			}),
		).toBeNull();
	});

	test("unconfigured provider is null", async () => {
		expect(await run(async () => Response.json(quota), { cfg: undefined })).toBeNull();
	});
});
