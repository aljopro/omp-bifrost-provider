/**
 * Bifrost AI Gateway provider for oh-my-pi (omp).
 *
 * Registers a `bifrost` provider that discovers models from a Bifrost gateway
 * (GET {base}/models) and sends inference through Bifrost's OpenAI-compatible
 * Chat Completions endpoint ({base}/chat/completions) using omp's built-in
 * `openai-completions` transport.
 *
 * Configuration (first match wins per field):
 *   - env:  BIFROST_URL, BIFROST_API_KEY, BIFROST_VIRTUAL_KEY
 *   - file: <agentDir>/bifrost.json  ({ "url": "...", "virtualKey": "..." }),
 *           written by `/login bifrost`; the API key from /login lives in
 *           omp's credential store, not in this file.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { createBifrostUsageProvider } from "./usage.ts";

export const PROVIDER_ID = "bifrost";
const API = "openai-completions" as const;

/** Sent as the bearer when no API key is configured (keyless gateways). */
export const KEYLESS_PLACEHOLDER = "bifrost-keyless";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 15_000;
const KNOWN_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof KNOWN_EFFORTS)[number];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BifrostConfig {
	/** OpenAI-compatible base URL, always ending in `/v1`. */
	baseUrl: string;
	/** Governance virtual key, sent as `x-bf-vk`. */
	virtualKey?: string;
	/** Where `baseUrl` came from, for /bifrost status. */
	source: "env" | "file";
}

interface StoredConfig {
	url?: string;
	virtualKey?: string;
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Turn whatever the user typed into Bifrost's OpenAI-compatible base URL.
 *   http://localhost:8080                  -> http://localhost:8080/v1
 *   http://localhost:8080/openai           -> http://localhost:8080/openai/v1
 *   http://host/v1/chat/completions        -> http://host/v1
 *   https://gw.example.com/bifrost/v1      -> unchanged
 */
export function normalizeBaseUrl(raw: string): string {
	const input = raw.trim();
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Invalid Bifrost URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Bifrost URL must use http:// or https://");
	}
	if (url.search || url.hash) throw new Error("Bifrost URL must not contain a query string or fragment");

	let p = url.pathname.replace(/\/+$/u, "");
	p = p.replace(/\/(?:chat\/completions|models)$/u, "");
	if (!/\/v1$/u.test(p)) p = `${p}/v1`;
	url.pathname = p;
	return url.toString().replace(/\/$/u, "");
}

function configFilePath(): string {
	return path.join(getAgentDir(), "bifrost.json");
}

async function readStoredConfig(): Promise<StoredConfig> {
	try {
		const parsed = JSON.parse(await fs.readFile(configFilePath(), "utf8")) as StoredConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

async function writeStoredConfig(config: StoredConfig): Promise<void> {
	const file = configFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function resolveConfig(env: NodeJS.ProcessEnv = process.env): Promise<BifrostConfig | undefined> {
	const stored = await readStoredConfig();
	const envUrl = nonEmpty(env.BIFROST_URL);
	const url = envUrl ?? nonEmpty(stored.url);
	if (!url) return undefined;
	return {
		baseUrl: normalizeBaseUrl(url),
		virtualKey: nonEmpty(env.BIFROST_VIRTUAL_KEY) ?? nonEmpty(stored.virtualKey),
		source: envUrl ? "env" : "file",
	};
}

function realKey(apiKey: string | undefined): string | undefined {
	const key = nonEmpty(apiKey);
	return key && key !== KEYLESS_PLACEHOLDER ? key : undefined;
}

/**
 * What to hand omp as the provider `apiKey`. omp always sends `Authorization: Bearer <key>` and
 * an extension cannot suppress it, so pick the most meaningful bearer available:
 *   1. BIFROST_API_KEY            (env-var name; omp resolves it per request)
 *   2. the virtual key            (Bifrost accepts a VK as the bearer as well as via x-bf-vk)
 *   3. a keyless placeholder      (open gateways ignore it)
 * With an `oauth` login registered this is only a fallback: a key saved by `/login bifrost` wins.
 */
export function bearerKeyConfig(config: BifrostConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (nonEmpty(env.BIFROST_API_KEY)) return "BIFROST_API_KEY";
	if (nonEmpty(env.BIFROST_VIRTUAL_KEY)) return "BIFROST_VIRTUAL_KEY";
	return config?.virtualKey ?? KEYLESS_PLACEHOLDER;
}

function requestHeaders(config: BifrostConfig, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	const key = realKey(apiKey);
	if (key) headers.Authorization = `Bearer ${key}`;
	if (config.virtualKey) headers["x-bf-vk"] = config.virtualKey;
	return headers;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/** Subset of Bifrost's `schemas.Model` (core/schemas/models.go) that we read. */
export interface BifrostModel {
	id?: string;
	name?: string;
	normalized_name?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
	top_provider?: { context_length?: number; max_completion_tokens?: number };
	per_request_limits?: { prompt_tokens?: number; completion_tokens?: number };
	supported_parameters?: string[];
	supported_methods?: string[];
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
		default_effort?: string;
	};
	is_deprecated?: boolean;
}

/** The fields we borrow from omp's bundled catalog when Bifrost omits them. */
export interface CatalogHint {
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	efforts?: Effort[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export type CatalogLookup = (bifrostId: string) => CatalogHint | undefined;

function positiveInt(...values: unknown[]): number | undefined {
	for (const v of values) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
	}
	return undefined;
}

/** Bifrost (like OpenRouter) quotes prices in USD per token; omp wants USD per million. */
function perMillion(value: string | number | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = typeof value === "number" ? value : Number.parseFloat(value);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n * 1_000_000;
}

const NON_CHAT_ID = /(?:^|[/-])(?:embed|embedding|text-embedding|whisper|tts|transcribe|dall-e|imagen|gpt-image|moderation|rerank|sora|veo)(?:[-/.:]|$)/iu;

function isChatModel(model: BifrostModel): boolean {
	const methods = (model.supported_methods ?? []).map(m => m.toLowerCase());
	if (methods.length > 0) return methods.some(m => /chat|completion|response|message|generate/u.test(m));
	const out = (model.architecture?.output_modalities ?? []).map(m => m.toLowerCase());
	if (out.length > 0 && !out.includes("text")) return false;
	return !NON_CHAT_ID.test(model.id ?? "");
}

function efforts(list: readonly string[] | undefined): Effort[] | undefined {
	if (!list?.length) return undefined;
	const wanted = new Set(list.map(e => e.toLowerCase()));
	const result = KNOWN_EFFORTS.filter(e => wanted.has(e));
	return result.length ? result : undefined;
}

export function toModelConfig(
	model: BifrostModel,
	baseUrl: string,
	catalog?: CatalogLookup,
	onDefaultLimits?: (id: string) => void,
): ProviderModelConfig | undefined {
	const id = nonEmpty(model.id);
	if (!id || !isChatModel(model)) return undefined;
	const hint = catalog?.(id);

	const knownContext =
		positiveInt(
			model.context_length,
			model.top_provider?.context_length,
			model.max_input_tokens && model.max_output_tokens ? model.max_input_tokens + model.max_output_tokens : undefined,
		) ?? hint?.contextWindow;
	if (knownContext === undefined) onDefaultLimits?.(id);
	const contextWindow = knownContext ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(
		contextWindow,
		positiveInt(model.max_output_tokens, model.top_provider?.max_completion_tokens, model.per_request_limits?.completion_tokens) ??
			hint?.maxTokens ??
			DEFAULT_MAX_TOKENS,
	);

	const params = (model.supported_parameters ?? []).map(p => p.toLowerCase());
	const bifrostEfforts = efforts(model.reasoning?.supported_efforts);
	const reasoning =
		model.reasoning !== undefined || params.some(p => p.includes("reasoning")) || hint?.reasoning === true;
	const effortList = bifrostEfforts ?? hint?.efforts;
	const defaultEffort = efforts(model.reasoning?.default_effort ? [model.reasoning.default_effort] : undefined)?.[0];

	const modalities = (model.architecture?.input_modalities ?? []).map(m => m.toLowerCase());
	const input: ("text" | "image")[] =
		modalities.length > 0 ? (modalities.some(m => m.includes("image")) ? ["text", "image"] : ["text"]) : (hint?.input ?? ["text"]);

	const inputPrice = perMillion(model.pricing?.prompt);
	const cost =
		inputPrice !== undefined
			? {
					input: inputPrice,
					output: perMillion(model.pricing?.completion) ?? 0,
					cacheRead: perMillion(model.pricing?.input_cache_read) ?? inputPrice,
					cacheWrite: perMillion(model.pricing?.input_cache_write) ?? inputPrice,
				}
			: (hint?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	const config: ProviderModelConfig & { baseUrl: string } = {
		id,
		name: nonEmpty(model.normalized_name) ?? nonEmpty(model.name) ?? id,
		api: API,
		baseUrl,
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
		// Bifrost normalises the OpenAI wire format across upstream providers.
		compat: {
			supportsDeveloperRole: true,
			supportsReasoningEffort: reasoning,
			supportsUsageInStreaming: true,
			maxTokensField: "max_completion_tokens",
		} as ProviderModelConfig["compat"],
	};
	if (reasoning && effortList) {
		config.thinking = {
			mode: "effort",
			efforts: effortList,
			...(defaultEffort ? { defaultLevel: defaultEffort } : {}),
		} as ProviderModelConfig["thinking"];
	}
	return config;
}

function errorDetail(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const b = body as { message?: unknown; error?: unknown };
	if (typeof b.error === "string") return b.error;
	if (b.error && typeof b.error === "object" && typeof (b.error as { message?: unknown }).message === "string") {
		return (b.error as { message: string }).message;
	}
	return typeof b.message === "string" ? b.message : undefined;
}

export async function fetchBifrostModels(
	config: BifrostConfig,
	apiKey: string | undefined,
	options: {
		fetch?: typeof fetch;
		catalog?: CatalogLookup;
		signal?: AbortSignal;
		/** Called with the ids that fell back to the default context window. */
		onDefaultLimits?: (ids: string[]) => void;
	} = {},
): Promise<ProviderModelConfig[]> {
	const doFetch = options.fetch ?? fetch;
	const signal = options.signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const response = await doFetch(`${config.baseUrl}/models`, { headers: requestHeaders(config, apiKey), signal });
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		const detail = errorDetail(body);
		throw new Error(`Bifrost model discovery failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}
	const data = (body as { data?: unknown } | undefined)?.data;
	if (!Array.isArray(data)) throw new Error("Bifrost /models returned an unexpected shape (expected { data: [] })");

	const byId = new Map<string, ProviderModelConfig>();
	const defaulted = new Set<string>();
	for (const entry of data as BifrostModel[]) {
		const model = toModelConfig(entry, config.baseUrl, options.catalog, id => defaulted.add(id));
		if (model && !byId.has(model.id)) byId.set(model.id, model);
	}
	if (defaulted.size > 0) options.onDefaultLimits?.([...defaulted].sort());
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// omp catalog enrichment
// ---------------------------------------------------------------------------

/** Bifrost provider prefix -> omp catalog provider ids to try, in order. */
const PROVIDER_ALIASES: Record<string, string[]> = {
	gemini: ["google"],
	vertex: ["google-vertex", "google"],
	bedrock: ["amazon-bedrock", "anthropic"],
	azure: ["openai"],
	"azure-openai": ["openai"],
	xai: ["xai"],
	mistral: ["mistral"],
	groq: ["groq"],
	cerebras: ["cerebras"],
	openrouter: ["openrouter"],
};

type GetBundledModel = (provider: string, id: string) => unknown;

interface CatalogModelLike {
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	thinking?: { efforts?: readonly string[] };
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export function createCatalogLookup(getBundledModel: GetBundledModel): CatalogLookup {
	const tryGet = (provider: string, id: string): CatalogModelLike | undefined => {
		try {
			return (getBundledModel(provider, id) as CatalogModelLike | undefined) ?? undefined;
		} catch {
			return undefined;
		}
	};
	return (bifrostId: string) => {
		const slash = bifrostId.indexOf("/");
		const prefix = slash > 0 ? bifrostId.slice(0, slash).toLowerCase() : "";
		const rest = slash > 0 ? bifrostId.slice(slash + 1) : bifrostId;
		const providers = prefix ? [prefix, ...(PROVIDER_ALIASES[prefix] ?? [])] : ["openai", "anthropic", "google"];
		const ids = [...new Set([rest, rest.toLowerCase(), rest.replace(/-\d{8}$/u, "")])];

		let found: CatalogModelLike | undefined;
		outer: for (const provider of providers) {
			for (const id of ids) {
				found = tryGet(provider, id);
				if (found) break outer;
			}
		}
		// OpenRouter's catalog already uses `vendor/model` ids.
		found ??= tryGet("openrouter", bifrostId);
		if (!found) return undefined;

		const c = found.cost;
		return {
			contextWindow: positiveInt(found.contextWindow),
			maxTokens: positiveInt(found.maxTokens),
			input: found.input,
			reasoning: found.reasoning,
			efforts: efforts(found.thinking?.efforts as string[] | undefined),
			cost:
				c && typeof c.input === "number" && typeof c.output === "number"
					? { input: c.input, output: c.output, cacheRead: c.cacheRead ?? c.input, cacheWrite: c.cacheWrite ?? c.input }
					: undefined,
		};
	};
}

async function loadCatalogLookup(): Promise<CatalogLookup | undefined> {
	try {
		const mod = (await import("@oh-my-pi/pi-catalog")) as { getBundledModel?: GetBundledModel };
		return mod.getBundledModel ? createCatalogLookup(mod.getBundledModel) : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function bifrostExtension(pi: ExtensionAPI): Promise<void> {
	const catalog = await loadCatalogLookup();
	let lastModels: ProviderModelConfig[] = [];
	let lastStatus = "not yet discovered";

	// Notices wait for the UI: writing to the terminal while omp's TUI owns it would garble
	// the prompt. Discovery can run before session_start, so queue until then.
	let ui: ExtensionContext["ui"] | undefined;
	const queued: Array<[string, "info" | "warning" | "error"]> = [];
	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (ui) ui.notify(message, level);
		else if (!process.stdout.isTTY) process.stderr.write(`omp-bifrost-provider: ${message}\n`);
		else queued.push([message, level]);
	};
	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		for (const [message, level] of queued.splice(0)) ctx.ui.notify(message, level);
	});

	const announced = new Set<string>();
	const warnDefaultLimits = (ids: string[]) => {
		const fresh = ids.filter(id => !announced.has(id));
		if (fresh.length === 0) return;
		for (const id of fresh) announced.add(id);
		const preview = fresh.slice(0, 5).join(", ") + (fresh.length > 5 ? `, +${fresh.length - 5} more` : "");
		notify(
			`Bifrost: no context size known for ${fresh.length} model(s) (${preview}); assuming ${DEFAULT_CONTEXT_WINDOW / 1000}k. ` +
				"Pin real values with providers.bifrost.modelOverrides in ~/.omp/agent/models.yml.",
			"warning",
		);
	};

	const discover = async (apiKey: string | undefined): Promise<readonly ProviderModelConfig[]> => {
		const config = await resolveConfig();
		if (!config) {
			lastStatus = "no Bifrost URL configured";
			return [];
		}
		const models = await fetchBifrostModels(config, apiKey ?? process.env.BIFROST_API_KEY, {
			catalog,
			onDefaultLimits: warnDefaultLimits,
		});
		lastModels = models;
		lastStatus = `${models.length} models discovered at ${new Date().toLocaleTimeString()}`;
		return models;
	};

	// Virtual-key budgets and rate limits for /usage and usage-aware fallback.
	const usage = createBifrostUsageProvider(PROVIDER_ID, { resolve: resolveConfig });

	const providerConfig = async (models?: ProviderModelConfig[]): Promise<ProviderConfig> => {
		const config = await resolveConfig();
		return {
			api: API,
			apiKey: bearerKeyConfig(config),
			usage,
			...(config ? { baseUrl: config.baseUrl } : {}),
			...(config?.virtualKey ? { headers: { "x-bf-vk": config.virtualKey } } : {}),
			...(models?.length ? { models } : {}),
			fetchDynamicModels: discover,
			oauth: {
				name: "Bifrost AI Gateway",
				async login(callbacks) {
					const prompt = callbacks.onPrompt;
					const current = await resolveConfig();
					const url = normalizeBaseUrl(
						await prompt({
							message: "Bifrost URL (e.g. http://localhost:8080)",
							placeholder: current?.baseUrl ?? "http://localhost:8080",
						}),
					);
					const apiKey = nonEmpty(
						await prompt({ message: "Bifrost API key (optional, Enter to skip)", allowEmpty: true, secret: true }),
					);
					const virtualKey = nonEmpty(
						await prompt({ message: "Bifrost virtual key (optional, Enter to skip)", allowEmpty: true, secret: true }),
					);
					callbacks.onProgress?.("Checking Bifrost and discovering models...");
					const probe: BifrostConfig = { baseUrl: url, virtualKey, source: "file" };
					const models = await fetchBifrostModels(probe, apiKey, {
						catalog,
						signal: callbacks.signal,
						onDefaultLimits: warnDefaultLimits,
					});
					await writeStoredConfig({ url, ...(virtualKey ? { virtualKey } : {}) });
					lastModels = models;
					lastStatus = `${models.length} models discovered at login`;
					pi.registerProvider(PROVIDER_ID, await providerConfig(models));
					callbacks.onProgress?.(`Found ${models.length} Bifrost models.`);
					// With no API key, the virtual key doubles as the bearer (Bifrost accepts both).
					return apiKey ?? virtualKey ?? KEYLESS_PLACEHOLDER;
				},
			},
		};
	};

	pi.registerProvider(PROVIDER_ID, await providerConfig());

	const savedKey = async (ctx: ExtensionContext): Promise<string | undefined> => {
		try {
			return realKey(await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_ID));
		} catch {
			return undefined;
		}
	};

	pi.registerCommand("bifrost", {
		description: "Bifrost gateway: status | refresh (setup: /login bifrost)",
		getArgumentCompletions: (prefix: string) =>
			["status", "refresh"].filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().toLowerCase() || "status";
			if (sub === "refresh") {
				try {
					const models = [...(await discover(nonEmpty(process.env.BIFROST_API_KEY) ?? (await savedKey(ctx))))];
					pi.registerProvider(PROVIDER_ID, await providerConfig(models));
					ctx.ui.notify(`Bifrost: ${models.length} models refreshed`, "info");
				} catch (error) {
					ctx.ui.notify(`Bifrost refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (sub === "status") {
				const config = await resolveConfig();
				const envKey = nonEmpty(process.env.BIFROST_API_KEY);
				const saved = await savedKey(ctx);
				const keyDesc = envKey
					? "BIFROST_API_KEY (env)"
					: saved && saved !== config?.virtualKey
						? "saved by /login"
						: config?.virtualKey
							? "none (virtual key is sent as the bearer)"
							: "none (keyless)";
				ctx.ui.notify(
					[
						`Bifrost URL: ${config ? `${config.baseUrl} (${config.source === "env" ? "BIFROST_URL" : configFilePath()})` : "not configured — run /login bifrost or set BIFROST_URL"}`,
						`API key: ${keyDesc}`,
						`Virtual key: ${config?.virtualKey ? "set" : "none"}`,
						`Catalog: ${lastStatus}${lastModels.length ? ` (e.g. ${lastModels.slice(0, 3).map(m => m.id).join(", ")})` : ""}`,
						`omp catalog enrichment: ${catalog ? "on" : "unavailable"}`,
					].join("\n"),
					"info",
				);
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${args}". Use /bifrost status or /bifrost refresh.`, "warning");
		},
	});
}
