interface PacerState {
  nextStartAt: number;
}

const pacers = new Map<string, PacerState>();

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function waitUntil(startAt: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, startAt - Date.now());
  if (signal?.aborted) throw abortError(signal);
  if (delayMs === 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(abortError(signal!));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Reserve a FIFO request-start slot for one provider scope.
 *
 * This spaces request starts instead of serializing full streaming lifetimes: a slow response can
 * remain open while later requests start at the configured cadence. Reservations happen before
 * awaiting so concurrent callers cannot observe the same slot.
 */
export async function paceRequestStart(
  scope: string,
  maxRequestsPerMinute: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (maxRequestsPerMinute === undefined) return;
  const intervalMs = 60_000 / maxRequestsPerMinute;
  const now = Date.now();
  const state = pacers.get(scope) ?? { nextStartAt: now };
  const startAt = Math.max(now, state.nextStartAt);
  state.nextStartAt = startAt + intervalMs;
  pacers.set(scope, state);
  await waitUntil(startAt, signal);
}

/** Test-only reset for the process-global provider pacing ledger. */
export function resetRequestPacersForTest(): void {
  pacers.clear();
}
