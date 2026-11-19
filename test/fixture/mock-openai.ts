// Minimal upstreams for Bifrost to route to, logging request headers and bodies:
//   /v1/...            OpenAI Chat Completions
//   /anthropic/v1/...  Anthropic Messages, with simulated prompt caching
const port = Number(process.env.MOCK_PORT ?? 18081);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// "acme-mystery-1" is unknown to Bifrost and omp's catalog: it exercises the default-limits warning.
const models = ["gpt-4o", "gpt-4o-mini", "o4-mini", "acme-mystery-1"].map(id => ({ id, object: "model", created: 1700000000, owned_by: "openai" }));
const claudeModels = [{ id: "claude-sonnet-5-5", type: "model", display_name: "Claude Sonnet 5.5", created_at: "2026-01-01T00:00:00Z" }];

/** Anthropic only caches when a request carries cache_control; report it the way the real API does. */
const CACHED_PREFIX_TOKENS = 4000;
let cacheWritten = false;

function hasCacheControl(value: unknown): boolean {
	return JSON.stringify(value).includes('"cache_control"');
}

async function anthropic(req: Request, path: string): Promise<Response> {
	if (path === "/v1/models") return Response.json({ data: claudeModels, has_more: false, first_id: claudeModels[0]!.id, last_id: claudeModels[0]!.id });
	if (path !== "/v1/messages" || req.method !== "POST") return new Response("not found", { status: 404 });

	const body = (await req.json()) as { model: string; stream?: boolean };
	const marked = hasCacheControl(body);
	log("ANTHROPIC_BODY", JSON.stringify(body).slice(0, 2000));
	log(`ANTHROPIC_CACHE_CONTROL ${marked ? "present" : "absent"}`);

	// Real Anthropic: first marked request writes the prefix, later ones read it. Unmarked requests do neither.
	const usage = {
		input_tokens: marked ? 50 : CACHED_PREFIX_TOKENS + 50,
		cache_creation_input_tokens: marked && !cacheWritten ? CACHED_PREFIX_TOKENS : 0,
		cache_read_input_tokens: marked && cacheWritten ? CACHED_PREFIX_TOKENS : 0,
		output_tokens: 6,
	};
	if (marked) cacheWritten = true;
	const text = `pong from mock anthropic (${body.model})`;
	const message = { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage };

	if (!body.stream) {
		return Response.json({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn" });
	}
	const ev = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
	const sse = [
		ev("message_start", { message: { ...message, usage: { ...usage, output_tokens: 1 } } }),
		ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
		ev("content_block_stop", { index: 0 }),
		ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }),
		ev("message_stop", {}),
	];
	return new Response(sse.join(""), { headers: { "content-type": "text/event-stream" } });
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		log(req.method, url.pathname, JSON.stringify(Object.fromEntries(req.headers)));
		if (url.pathname.startsWith("/anthropic/")) return anthropic(req, url.pathname.slice("/anthropic".length));

		const p = url.pathname.replace(/^\/v1/, "");
		if (p === "/models") return Response.json({ object: "list", data: models });
		if (p === "/chat/completions" && req.method === "POST") {
			const body = (await req.json()) as { model: string; stream?: boolean; messages: { role: string; content: unknown }[] };
			log("BODY", JSON.stringify(body).slice(0, 2000));
			const text = `pong from mock (${body.model})`;
			if (!body.stream) {
				return Response.json({
					id: "chatcmpl-mock", object: "chat.completion", created: 1, model: body.model,
					choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				});
			}
			const chunk = (delta: object, finish: string | null = null, usage?: object) =>
				`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
			const parts = [chunk({ role: "assistant", content: "" }), ...text.split(" ").map((w, i) => chunk({ content: (i ? " " : "") + w })), chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), "data: [DONE]\n\n"];
			return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	},
});
log(`mock upstreams listening on ${port} (OpenAI at /v1, Anthropic at /anthropic/v1)`);
