/**
 * Bifrost virtual-key quota → omp usage reports.
 *
 * Bifrost serves `GET {root}/api/governance/virtual-keys/quota` as a self-service endpoint: the
 * virtual key itself is the credential (no admin auth). It returns the key's budgets (USD) and
 * rate limits (tokens / requests). We map those onto omp's `UsageReport` so they show up in
 * `/usage`, `omp usage`, and feed `usageAwareFallback`.
 *
 * Everything here fails quietly: a gateway that is too old, a proxy that only exposes `/v1`, or a
 * key with no limits all yield `null` ("this provider reports no usage"), never an error.
 */
import type { UsageLimit, UsageProvider, UsageReport, UsageStatus, UsageWindow } from "@oh-my-pi/pi-ai";

const QUOTA_PATH = "/api/governance/virtual-keys/quota";
const QUOTA_TIMEOUT_MS = 10_000;
/** How long omp waits before re-asking after a null/failed report (unsupported gateways stay quiet). */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const WARNING_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Bifrost response shapes (transports/bifrost-http/handlers/governance.go)
// ---------------------------------------------------------------------------

export interface BifrostBudget {
	id: string;
	max_limit?: number;
	current_usage?: number;
	reset_duration?: string;
	last_reset?: string;
}

export interface BifrostRateLimit {
	id: string;
	token_max_limit?: number | null;
	token_current_usage?: number;
	token_reset_duration?: string | null;
	token_last_reset?: string;
	request_max_limit?: number | null;
	request_current_usage?: number;
	request_reset_duration?: string | null;
	request_last_reset?: string;
}

export interface BifrostQuota {
	virtual_key_name?: string;
	is_active?: boolean;
	budgets?: BifrostBudget[] | null;
	rate_limit?: BifrostRateLimit | null;
	rate_limits?: BifrostRateLimit[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `http://gw/v1` or `http://gw/openai/v1` → `http://gw` (reverse-proxy prefixes are kept). */
export function gatewayRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/(?:\/openai)?\/v1$/u, "");
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const UNIT_LABEL: Record<string, [string, string]> = {
	s: ["second", "seconds"],
	m: ["minute", "minutes"],
	h: ["hour", "hours"],
	d: ["day", "days"],
	w: ["week", "weeks"],
	M: ["month", "months"],
	Q: ["quarter", "quarters"],
	Y: ["year", "years"],
};
const ADJECTIVE: Record<string, string> = {
	"1h": "Hourly",
	"1d": "Daily",
	"1w": "Weekly",
	"1M": "Monthly",
	"1Q": "Quarterly",
	"1Y": "Yearly",
};

interface Period {
	count: number;
	unit: string;
}

/** Bifrost durations: "30s", "5m", "1h", "1d", "1w", "1M", "1Q", "1Y" (M = month, m = minute). */
export function parsePeriod(raw: string | null | undefined): Period | undefined {
	const match = /^(\d+)([smhdwMQY])$/u.exec(raw?.trim() ?? "");
	if (!match) return undefined;
	const count = Number.parseInt(match[1]!, 10);
	return count > 0 ? { count, unit: match[2]! } : undefined;
}

function periodLabel(raw: string, period: Period): string {
	if (ADJECTIVE[raw]) return ADJECTIVE[raw]!;
	const [one, many] = UNIT_LABEL[period.unit]!;
	return `${period.count} ${period.count === 1 ? one : many}`;
}

/** Next reset = last reset + one period (calendar arithmetic for months/quarters/years). */
export function nextReset(lastReset: string | undefined, period: Period): number | undefined {
	const start = lastReset ? Date.parse(lastReset) : Number.NaN;
	if (!Number.isFinite(start)) return undefined;
	const fixed = UNIT_MS[period.unit];
	if (fixed) return start + period.count * fixed;
	const months = period.count * (period.unit === "M" ? 1 : period.unit === "Q" ? 3 : 12);
	const d = new Date(start);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.getTime();
}

function windowFor(raw: string | null | undefined, lastReset: string | undefined): UsageWindow | undefined {
	if (!raw) return undefined;
	const period = parsePeriod(raw);
	if (!period) return { id: raw, label: raw };
	const fixed = UNIT_MS[period.unit];
	return {
		id: raw,
		label: periodLabel(raw, period),
		...(fixed ? { durationMs: period.count * fixed } : {}),
		...(nextReset(lastReset, period) !== undefined ? { resetsAt: nextReset(lastReset, period) } : {}),
	};
}

function statusFor(used: number, limit: number, inactive: boolean): UsageStatus {
	if (inactive || used >= limit) return "exhausted";
	return used / limit >= WARNING_FRACTION ? "warning" : "ok";
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function amount(used: number, limit: number, unit: "usd" | "tokens" | "requests") {
	return {
		used,
		limit,
		remaining: Math.max(0, limit - used),
		usedFraction: used / limit,
		remainingFraction: Math.max(0, 1 - used / limit),
		unit,
	};
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Map a quota response to an omp usage report; `null` when the key has no limits to show. */
export function quotaToReport(quota: BifrostQuota, provider: string, now = Date.now()): UsageReport | null {
	const inactive = quota.is_active === false;
	const scope = { provider, ...(quota.virtual_key_name ? { accountId: quota.virtual_key_name } : {}) };
	const limits: UsageLimit[] = [];

	for (const budget of quota.budgets ?? []) {
		const limit = positive(budget.max_limit);
		if (!limit) continue;
		const used = nonNegative(budget.current_usage);
		const window = windowFor(budget.reset_duration, budget.last_reset);
		limits.push({
			id: `budget:${budget.id}`,
			label: `${window?.label ?? "Budget"} budget`,
			scope,
			...(window ? { window } : {}),
			amount: amount(used, limit, "usd"),
			status: statusFor(used, limit, inactive),
		});
	}

	// `rate_limits` is the full list; older gateways only send the single `rate_limit`.
	const rateLimits = quota.rate_limits?.length ? quota.rate_limits : quota.rate_limit ? [quota.rate_limit] : [];
	const seen = new Set<string>();
	for (const rl of rateLimits) {
		if (seen.has(rl.id)) continue;
		seen.add(rl.id);
		const tokenLimit = positive(rl.token_max_limit);
		if (tokenLimit) {
			const used = nonNegative(rl.token_current_usage);
			const window = windowFor(rl.token_reset_duration, rl.token_last_reset);
			limits.push({
				id: `tokens:${rl.id}`,
				label: `Tokens${window ? ` (${window.label.toLowerCase()})` : ""}`,
				scope,
				...(window ? { window } : {}),
				amount: amount(used, tokenLimit, "tokens"),
				status: statusFor(used, tokenLimit, inactive),
			});
		}
		const requestLimit = positive(rl.request_max_limit);
		if (requestLimit) {
			const used = nonNegative(rl.request_current_usage);
			const window = windowFor(rl.request_reset_duration, rl.request_last_reset);
			limits.push({
				id: `requests:${rl.id}`,
				label: `Requests${window ? ` (${window.label.toLowerCase()})` : ""}`,
				scope,
				...(window ? { window } : {}),
				amount: amount(used, requestLimit, "requests"),
				status: statusFor(used, requestLimit, inactive),
			});
		}
	}

	if (limits.length === 0 && !inactive) return null;
	return {
		provider,
		fetchedAt: now,
		limits,
		notes: [
			...(inactive ? ["This Bifrost virtual key is inactive."] : []),
			"Bifrost saves these totals about every 10 seconds, so the newest requests may not be counted yet.",
		],
		...(quota.virtual_key_name ? { metadata: { virtualKeyName: quota.virtual_key_name } } : {}),
	};
}

// ---------------------------------------------------------------------------
// Usage provider
// ---------------------------------------------------------------------------

export interface QuotaSource {
	/** Current gateway base URL (…/v1) and virtual key, read fresh on every fetch. */
	resolve(): Promise<{ baseUrl: string; virtualKey?: string } | undefined>;
}

/**
 * A virtual key is what Bifrost's quota endpoint authenticates. Prefer the configured one; else
 * the request key itself when it is a VK (`sk-bf-…`), as it is in virtual-key-only setups.
 */
function pickVirtualKey(configured: string | undefined, requestKey: string | undefined): string | undefined {
	if (configured) return configured;
	return requestKey?.startsWith("sk-bf-") ? requestKey : undefined;
}

export function createBifrostUsageProvider(providerId: string, source: QuotaSource): UsageProvider {
	return {
		id: providerId as UsageProvider["id"],
		cacheVersion: 1,
		usesRequestKey: true,
		failureBackoffMs: FAILURE_BACKOFF_MS,
		async fetchUsage(params, ctx) {
			const config = await source.resolve();
			if (!config) return null;
			const virtualKey = pickVirtualKey(config.virtualKey, params.credential.apiKey);
			if (!virtualKey) return null;

			const url = `${gatewayRoot(config.baseUrl)}${QUOTA_PATH}`;
			const timeout = AbortSignal.timeout(QUOTA_TIMEOUT_MS);
			try {
				const response = await ctx.fetch(url, {
					headers: { Accept: "application/json", "x-bf-vk": virtualKey },
					signal: params.signal ? AbortSignal.any([params.signal, timeout]) : timeout,
				});
				if (!response.ok) {
					// 404: gateway too old or /api not exposed by the proxy. 401/403: blocked. Either way, no data.
					ctx.logger?.debug("Bifrost quota unavailable", { status: response.status, url });
					return null;
				}
				return quotaToReport((await response.json()) as BifrostQuota, providerId);
			} catch (error) {
				ctx.logger?.debug("Bifrost quota fetch failed", { error: String(error), url });
				return null;
			}
		},
	};
}
