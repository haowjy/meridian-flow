import { startSmokeServer } from "./server.js";

async function main(): Promise<void> {
  const server = await startSmokeServer();

  try {
    const healthRes = await fetch(`${server.baseUrl}/health`);
    if (!healthRes.ok) {
      throw new Error(`/health failed: ${healthRes.status} ${await healthRes.text()}`);
    }
    const health = (await healthRes.json()) as {
      status: string;
      providers: string[];
      defaultModel?: string;
    };
    console.log("health:", JSON.stringify(health, null, 2));

    if (health.status !== "ok") {
      throw new Error(`unexpected health status: ${health.status}`);
    }
    if (health.providers.length === 0) {
      throw new Error("health.providers is empty");
    }

    const generateRes = await fetch(`${server.baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      }),
    });

    const generateBody = await generateRes.json();
    if (!generateRes.ok) {
      throw new Error(`/generate failed: ${generateRes.status} ${JSON.stringify(generateBody)}`);
    }

    console.log("generate:", JSON.stringify(generateBody, null, 2));

    const result = generateBody as {
      content: Array<{ type: string }>;
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
      model: string;
      provider: string;
    };

    if (!result.content.some((p) => p.type === "text")) {
      throw new Error("generate result missing text content");
    }
    if (!result.finishReason) {
      throw new Error("generate result missing finishReason");
    }
    if (result.usage.outputTokens <= 0) {
      throw new Error("generate result usage.outputTokens is zero");
    }
    if (!result.model || !result.provider) {
      throw new Error("generate result missing model or provider");
    }

    console.log("smoke self-test passed");
  } finally {
    await server.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
