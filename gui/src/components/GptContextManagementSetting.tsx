import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";
import { useT } from "../i18n/shared";
import type { NoticeTone } from "../ui";

type Feedback = { tone: NoticeTone; message: string } | null;

/** Explicit opt-in for native GPT History/Notes context management. */
export default function GptContextManagementSetting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const enabledRef = useRef(false);
  const savingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (savingRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!response.ok) throw new Error("load");
      const payload = await response.json() as { gptContextManagement?: unknown };
      if (savingRef.current || generation !== loadGenerationRef.current) return;
      if (typeof payload.gptContextManagement !== "boolean") throw new Error("shape");
      enabledRef.current = payload.gptContextManagement;
      setEnabled(payload.gptContextManagement);
      setHydrated(true);
      setLoadError(false);
    } catch {
      if (!savingRef.current && generation === loadGenerationRef.current) {
        setLoadError(true);
      }
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const stop = startVisibilityPoll(() => { void load(); }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, [load]);

  const toggle = useCallback(async () => {
    if (savingRef.current || !hydrated) return;
    const previous = enabledRef.current;
    const requested = !previous;
    enabledRef.current = requested;
    setEnabled(requested);
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    loadGenerationRef.current += 1;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        signal: bounded.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gptContextManagement: requested }),
      });
      const payload = (await readJsonOrThrow<{
        ok?: unknown;
        gptContextManagement?: unknown;
        catalogRefreshPending?: unknown;
      }>(response)) ?? {};
      if (payload.ok !== true || typeof payload.gptContextManagement !== "boolean") {
        throw new Error("unconfirmed");
      }
      enabledRef.current = payload.gptContextManagement;
      setEnabled(payload.gptContextManagement);
      setHydrated(true);
      setLoadError(false);
      setFeedback(payload.catalogRefreshPending === true
        ? { tone: "warn", message: t("codexAuth.catalogRefreshPending") }
        : { tone: "ok", message: t("codexAuth.contextManagementUpdated") });
    } catch {
      enabledRef.current = previous;
      setEnabled(previous);
      setFeedback({ tone: "err", message: t("codexAuth.contextManagementUpdateFailed") });
    } finally {
      bounded.clear();
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, hydrated, t]);

  const initialLoadFailed = loadError && !hydrated;

  return (
    <div
      className="card card-row codex-account-picker-card gpt-context-management-card"
      aria-busy={saving || (!hydrated && !initialLoadFailed) || undefined}
    >
      <div className="codex-account-picker-copy">
        <strong>{t("codexAuth.contextManagementTitle")}</strong>
        <div className="card-sub" role={initialLoadFailed ? "status" : undefined}>
          {initialLoadFailed
            ? t("codexAuth.contextManagementLoadFailed")
            : !hydrated
              ? t("common.loading")
              : t(enabled
                ? "codexAuth.contextManagementOnDesc"
                : "codexAuth.contextManagementOffDesc")}
        </div>
        {hydrated && (
          <div className="card-sub faint">{t("codexAuth.contextManagementCompatibility")}</div>
        )}
        {hydrated && loadError && (
          <div className="card-sub faint" role="status">
            {t("codexAuth.accountPickerRefreshFailed")}
          </div>
        )}
      </div>
      <div className="codex-account-picker-controls">
        {loadError && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { void load(); }}
            disabled={saving}
          >
            {t("common.retry")}
          </button>
        )}
        {hydrated && (
          <button
            type="button"
            className={`toggle ${enabled ? "on" : ""}`}
            onClick={() => { void toggle(); }}
            disabled={saving}
            aria-pressed={enabled}
            aria-label={t("codexAuth.contextManagementTitle")}
            title={t("codexAuth.contextManagementTitle")}
          >
            <span className="toggle-knob" />
          </button>
        )}
      </div>
      {feedback && (
        <div
          className={`codex-account-picker-feedback is-${feedback.tone}`}
          role={feedback.tone === "err" ? "alert" : "status"}
          aria-atomic="true"
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
