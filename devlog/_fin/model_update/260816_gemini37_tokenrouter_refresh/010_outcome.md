# 010 — outcome (D record)

Terminal outcome: DONE (repo + runtime); commit intentionally left to the operator.

## Runtime (live service, port 10100)
- tokenrouter selectedModels → 8 new ids; defaultModel `moonshotai/kimi-k3`
  (retired `moonshotai/kimi-k3-free` confirmed absent upstream); context windows
  patched via admin API and reflected in `/api/models`.
- `ocx sync`: `~/.codex/opencodex-catalog.json` 18 → 25 rows, new slugs present,
  dead kimi-k3-free slug dropped. `/v1/models` (client-facing) exposes all 8.
- End-to-end: `POST /v1/chat/completions` with `tokenrouter/google/gemini-3.7-flash`
  through the proxy returned a completion (2026-08-16).
- google-antigravity runtime: unchanged by design — this account's CCA
  `:fetchAvailableModels` still serves only the six 3.6-era models (live test
  endpoint: "6 models available"), so there is nothing to select yet; live
  discovery surfaces the 3.7 tiers automatically once Google rolls them out.
- Codex app-servers were NOT restarted (would SIGTERM active turns); the desktop
  picker picks the new rows after its next app-server restart.

## Repo diff (this unit only)
- `src/providers/antigravity-models.ts` — gemini-3.7-flash base + low/medium/high
  wire tiers, efforts, default effort medium, 1,048,576 windows, text+image.
- `scripts/model-metadata.source.json` — `google.gemini-3.7-flash` (0.75/3.75
  intro, cacheRead 0.075 derived — see 001) + regenerated
  `src/generated/model-metadata.ts` via `generate:model-metadata`.
- Tests updated to the 7-model collapsed list: `google-antigravity-wire`,
  `provider-registry-parity` (length 7 + 3.7 assertions + hidden suffix ids),
  `codex-catalog` (static row length 7), `oauth-provider-reconcile` (v1 canonical
  static row now pinned to the frozen six-model v1 shape instead of cloning the
  live preset).

## C evidence
- Affected suites (21 files incl. wire/static/reconcile/parity/catalog/golden/
  metadata-sync/usage-cost): **659 pass, 0 fail**.
- `bun run typecheck` — exit 0. `bun run privacy:scan` — passed.
- Full `bun run test`: 10,679 pass, ~7-8 fail — **all failures pre-existing**
  (reproduced identically with this unit's diff stashed; they sit in
  adapter-usage / openai-chat-eof / request-pacing territory, matching the
  operator's separate in-progress working-tree changes, not this diff).
- Known quirk recorded (002): selected-models/PATCH endpoints report
  `catalogRefresh: failed(disk,gather)` even on success — pre-existing.

## Not done / deferred
- `xai.grok-4.6`, `qwen3.8` bundle entries in the vendored snapshot: separate
  vendor-lane refresh.
- google-antigravity `defaultModel` flip to 3.7: revisit when CCA serves it.
- New-build install/restart of the live service: operator decision.
