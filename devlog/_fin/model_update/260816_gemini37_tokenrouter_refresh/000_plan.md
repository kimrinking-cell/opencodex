# 260816 — Gemini 3.7 Flash + TokenRouter August lineup refresh

## Loop-spec header (spec-satisfaction)
- **Trigger:** user request 2026-08-16 — "오픈코덱스 토큰라우터랑 안티그래비티 신모델 나온거 카탈로그에 안나오는데 추가 좀 해줄래" (new TokenRouter and Antigravity models missing from the catalog).
- **Goal:** the August-2026 wave (Gemini 3.7 Flash on both surfaces, TokenRouter's 8 new text models) is selectable: runtime catalog now, repo static seed/metadata for the next build.
- **Non-goals:** no new registry provider for tokenrouter (it is a user custom provider; live discovery already serves it); no defaultModel flip for google-antigravity (account-verified CCA reality still serves the 3.6 default — see 001); no other vendor lanes (grok-4.6/qwen3.8 bundle entries are a separate refresh).
- **Verifier:** affected suites (antigravity wire/static/reconcile/parity/catalog/metadata-sync) + `bun run typecheck` + full `bun run test`; runtime via admin API + `/v1/models` + one live completion through the proxy.
- **Stop:** all green + runtime rows verified. Escalation per LOOP-REPAIR-01.

## Phase map
1. **Runtime (user-visible now):** tokenrouter `selectedModels` → the 8 new ids; `defaultModel` off the dead `moonshotai/kimi-k3-free`; context windows patched in; `ocx sync` to republish the Codex catalog file.
2. **Repo (next build):** `gemini-3.7-flash` into `src/providers/antigravity-models.ts` (wire tiers low/medium/high following the 3.6 pattern) + `google` metadata bundle entry + regeneration + test updates.

Research evidence: 001 (Gemini 3.7 Flash lane), 002 (TokenRouter lane). D record: 010.
