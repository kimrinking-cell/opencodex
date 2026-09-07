import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import GptContextManagementSetting from "../src/components/GptContextManagementSetting";
import { LanguageProvider } from "../src/i18n/provider";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GptContextManagementSetting", () => {
  beforeEach(() => {
    previousDomGlobals = Object.fromEntries(
      domGlobals.map(key => [key, Reflect.get(globalThis, key)]),
    ) as typeof previousDomGlobals;
    testWindow = new Window({ url: "http://localhost/" });
    Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mountedRoot = null;
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => { mountedRoot?.unmount(); });
      mountedRoot = null;
    }
    for (const key of domGlobals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
    }
    await testWindow.happyDOM?.close?.();
  });

  async function mount(fetchMock: typeof fetch): Promise<HTMLElement> {
    globalThis.fetch = fetchMock;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <GptContextManagementSetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });
    return host;
  }

  function toggle(host: ParentNode): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!button) throw new Error("toggle missing");
    return button;
  }

  test("saves both directions through the context setting and reloads confirmed state", async () => {
    let enabled = true;
    const writes: unknown[] = [];
    const api = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        enabled = body.gptContextManagement;
        return response({ ok: true, gptContextManagement: enabled });
      }
      return response({ gptContextManagement: enabled });
    }) as typeof fetch;
    let host = await mount(api);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("original account");
    await act(async () => { toggle(host).click(); await flush(); });
    expect(writes).toEqual([{ gptContextManagement: false }]);
    expect(host.textContent).toContain("standard context compaction");
    expect(host.textContent).toContain("interrupt existing History/Notes tasks");
    await act(async () => { mountedRoot?.unmount(); mountedRoot = null; });
    host = await mount(api);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    await act(async () => { toggle(host).click(); await flush(); });
    expect(writes).toEqual([{ gptContextManagement: false }, { gptContextManagement: true }]);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
  });

  test("failed writes restore the confirmed state and expose an error", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "PUT"
      ? response({ error: "unavailable" }, 503) : response({ gptContextManagement: true })) as typeof fetch);
    await act(async () => { toggle(host).click(); await flush(); });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  });

  test("waits for hydration and serializes repeated clicks", async () => {
    const initial = deferred<Response>(); const saved = deferred<Response>(); let puts = 0;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") { puts++; return saved.promise; }
      return initial.promise;
    }) as typeof fetch);
    expect(host.querySelector("button.toggle")).toBeNull();
    await act(async () => { initial.resolve(response({ gptContextManagement: false })); await flush(); });
    act(() => { toggle(host).click(); toggle(host).click(); });
    expect(puts).toBe(1); expect(toggle(host).disabled).toBe(true);
    await act(async () => { saved.resolve(response({ ok: true, gptContextManagement: true })); await flush(); });
    expect(toggle(host).disabled).toBe(false);
  });
});
