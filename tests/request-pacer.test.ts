import { afterEach, describe, expect, test } from "bun:test";
import { paceRequestStart, resetRequestPacersForTest } from "../src/lib/request-pacer";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../src/types";

afterEach(() => resetRequestPacersForTest());

describe("provider request pacing", () => {
  test("spaces concurrent request starts without waiting for prior responses to finish", async () => {
    const starts: number[] = [];
    const fetchImpl: typeof globalThis.fetch = async () => {
      starts.push(Date.now());
      return new Response("ok");
    };
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://rate-limit.example/v1",
      maxRequestsPerMinute: 600,
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(provider);

    await Promise.all([
      send("https://rate-limit.example/v1/chat/completions"),
      send("https://rate-limit.example/v1/chat/completions"),
      send("https://rate-limit.example/v1/chat/completions"),
    ]);

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(85);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(85);
  });

  test("shares one pacing ledger across provider objects with the same base URL", async () => {
    const starts: number[] = [];
    const fetchImpl: typeof globalThis.fetch = async () => {
      starts.push(Date.now());
      return new Response("ok");
    };
    const provider = (baseUrl: string) => ({
      adapter: "openai-chat",
      baseUrl,
      maxRequestsPerMinute: 600,
      fetch: fetchImpl,
    }) as OcxProviderConfig & { fetch: typeof globalThis.fetch };

    await Promise.all([
      providerFetch(provider("https://rate-limit.example/v1"))("https://rate-limit.example/v1/chat/completions"),
      providerFetch(provider("https://rate-limit.example/v1/"))("https://rate-limit.example/v1/chat/completions"),
    ]);

    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(85);
  });

  test("does not invoke fetch when an enqueued request is aborted", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("ok");
    };
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://abort.example/v1",
      maxRequestsPerMinute: 60,
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(provider);
    await send("https://abort.example/v1/chat/completions");
    const controller = new AbortController();
    const queued = send("https://abort.example/v1/chat/completions", { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toHaveProperty("name", "AbortError");
    expect(calls).toBe(1);
  });
});
