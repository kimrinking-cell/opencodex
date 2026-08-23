# 002 — TokenRouter August lineup lane (runtime, custom provider)

TokenRouter is a user-config custom provider (config `providers.tokenrouter`, baseUrl
`https://api.tokenrouter.com/v1`, `liveModels: true`), not a registry provider. Live
discovery already returns the full upstream list; the Codex-side catalog gates rows
through `selectedModels`, which still held only the retired `moonshotai/kimi-k3-free`.

## Upstream evidence (account-verified, GET /v1/models 2026-08-16)
New since 2026-08-01 (created timestamps from the API):

| created | id | endpoint types |
|---|---|---|
| 2026-08-15 | qwen/qwen3.8-max | openai, openai-response |
| 2026-08-15 | qwen/qwen3.8-max-free | openai |
| 2026-08-13 | moonshotai/kimi-k3 | openai |
| 2026-08-13 | google/gemini-3.7-flash | gemini |
| 2026-08-13 | nvidia/nemotron-3.5-lightning | openai |
| 2026-08-13 | deepseek/deepseek-v4-pro-0813 | openai |
| 2026-08-13 | x-ai/grok-4.6 | openai |
| 2026-08-01 | deepseek/deepseek-v4-flash-0731 | openai |

`moonshotai/kimi-k3-free` no longer appears upstream (the service had already been
logging it as "omitted configured model ids").

## Runtime actions (admin API on the live service)
- `PUT /api/selected-models` tokenrouter → the 8 ids above.
- `PATCH /api/providers?name=tokenrouter` → `defaultModel: moonshotai/kimi-k3` (direct
  successor of the retired free tier; user can change in one click), plus
  `modelContextWindows`: qwen3.8(-free) 983,616 (matches the user's alibaba
  qwen3.8-max-preview row), kimi-k3 1,048,576, gemini-3.7-flash 1,048,576,
  grok-4.6 500,000 (OFFICIAL docs.x.ai), deepseek dated variants 1,048,576 (v4 family
  spec). nemotron-3.5-lightning left unset — no official context spec found.
- `ocx sync` republished `~/.codex/opencodex-catalog.json` (18 → 25 rows; the dead
  kimi-k3-free slug dropped by live-discovery omission).
- Codex app-servers keep the old in-memory list until they restart; `--restart-codex`
  was NOT run (would SIGTERM active turns).

Both `PUT /api/selected-models` and `PATCH /api/providers` return
`catalogRefresh: {status: failed, reason: disk, phase: gather}` even on success —
pre-existing endpoint behavior (their convergence call runs with a non-catalog scope,
convergence.ts:565); the actual disk refresh via `ocx sync` succeeds. Not a regression
from this unit.
