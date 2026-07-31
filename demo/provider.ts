import { join } from "node:path";

type RequestBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

type Scenario = "launch" | "busy" | "complete" | "retry" | "error" | "cost" | "unknown";

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(value, { status, headers });
}

function stream(
  model: string,
  toolCalls?: unknown[],
  usage?: { prompt_tokens: number; completion_tokens: number },
): Response {
  const created = Math.floor(Date.now() / 1_000);
  const chunk = (
    delta: Record<string, unknown>,
    finish_reason: string | null,
    tokens?: { prompt_tokens: number; completion_tokens: number },
  ) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-cafe",
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
      ...(tokens
        ? { usage: { ...tokens, total_tokens: tokens.prompt_tokens + tokens.completion_tokens } }
        : {}),
    })}\n\n`;
  const first = toolCalls
    ? chunk({ role: "assistant", tool_calls: toolCalls }, null)
    : chunk({ role: "assistant", content: "done" }, null);
  const finish = toolCalls ? "tool_calls" : "stop";
  return new Response(first + chunk({}, finish, usage) + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function launchCoffeeTasks(): unknown[] {
  const tasks = [
    ["brewer", "busy", "Brew the morning coffee"],
    ["taster", "idle", "Taste the espresso"],
    ["bean-scout", "retry", "Find the missing beans"],
    ["latte-artist", "error", "Attempt latte art"],
  ] as const;
  return tasks.map(([agent, status, description], index) => ({
    index,
    id: `call-coffee-${status}`,
    type: "function",
    function: {
      name: "task",
      arguments: JSON.stringify({
        description,
        prompt: `[status:${status}]`,
        subagent_type: agent,
      }),
    },
  }));
}

function scenario(body: RequestBody): Scenario {
  if (body.model === "decaf") return "cost";
  if (body.model !== "house-blend") return "unknown";

  const prompt = JSON.stringify(
    body.messages?.findLast((message) => message.role === "user")?.content,
  );
  if (prompt.includes("[status:busy]")) return "busy";
  if (prompt.includes("[status:retry]")) return "retry";
  if (prompt.includes("[status:error]")) return "error";

  const canLaunch = body.tools?.some((tool) => tool.function?.name === "task");
  const continuing = body.messages?.at(-1)?.role === "tool";
  return canLaunch && !continuing ? "launch" : "complete";
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return json({ error: { message: "not found" } }, 404);
    }

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return json({ error: { message: "invalid JSON" } }, 400);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return json({ error: { message: "invalid request" } }, 400);
    }
    const body = value as RequestBody;

    switch (scenario(body)) {
      case "cost":
        return stream("decaf", undefined, { prompt_tokens: 21, completion_tokens: 42 });
      case "busy":
        await Bun.sleep(30_000);
        return stream("house-blend");
      case "retry":
        return json({ error: { message: "cafe rate limit", type: "rate_limit_error" } }, 429, {
          "retry-after": "30",
        });
      case "error":
        return json({ error: { message: "cafe error", type: "invalid_request_error" } }, 400);
      case "launch":
        return stream("house-blend", launchCoffeeTasks());
      case "complete":
        return stream("house-blend");
      default:
        return json({ error: { message: "unknown cafe model" } }, 400);
    }
  },
});

const providerURL = `http://127.0.0.1:${server.port}`;

const child = Bun.spawn({
  cmd: ["opencode"],
  cwd: join(import.meta.dir, ".."),
  env: {
    ...process.env,
    OPENCODE_CONFIG: join(import.meta.dir, "opencode.jsonc"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_TUI_CONFIG: join(import.meta.dir, "tui.jsonc"),
    CAFE_PROVIDER_URL: providerURL,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  process.exitCode = await child.exited;
} finally {
  server.stop(true);
}
