// Minimal OpenAI-compatible upstream for Bifrost to route to. Logs request headers + bodies.
const port = Number(process.env.MOCK_PORT ?? 18081);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// "acme-mystery-1" is unknown to Bifrost and omp's catalog: it exercises the default-limits warning.
const models = ["gpt-4o", "gpt-4o-mini", "o4-mini", "acme-mystery-1"].map(id => ({ id, object: "model", created: 1700000000, owned_by: "openai" }));

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname.replace(/^\/v1/, "");
		log(req.method, url.pathname, JSON.stringify(Object.fromEntries(req.headers)));
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
log(`mock openai listening on ${port}`);
