# 001 — Gemini 3.7 Flash research lane (Antigravity + google bundle)

## Official sources
- OFFICIAL Antigravity blog, 2026-08-13: https://antigravity.google/blog/gemini-3-7-flash-in-google-antigravity — "Today, we are introducing Gemini 3.7 Flash"; intro price **$0.75/1M input, $3.75/1M output** ("half of the 3.6 Flash per-million-token cost"), ends 2026-12-31; from 2027-01-01 $1.50/$7.50. No context window / model id strings in the post.
- OFFICIAL model card: https://deepmind.google/models/model-cards/gemini-3-7-flash — "up to 1M" context, "64K token output", intro pricing as above, knowledge cutoff March 2026. Cached-token price **not stated**.
- OFFICIAL Gemini API docs (checked 2026-08-16): https://ai.google.dev/gemini-api/docs/latest-model — still documents 3.6 Flash as newest (page last updated 2026-07-30); 3.7 not yet tabulated there.
- Secondary (blog.google announcement summary, Digital Applied price note): consistent with the two OFFICIAL sources above.

## Decisions
- `google` bundle entry `gemini-3.7-flash`: contextWindow 1048576, maxTokens 65536, input text+image, reasoning true, cost input 0.75 / output 3.75 (intro period).
- **cacheRead 0.075 is derived, UNVERIFIED**: the model card omits cache pricing; 0.075 = half of 3.6 Flash's 0.15, following the same intro halving as input/output. Re-check when the API docs tabulate 3.7.
- Antigravity static seed adds base `gemini-3.7-flash` + wire tiers `gemini-3.7-flash-{low,medium,high}`, default effort medium — **ANTICIPATED** following two consecutive CCA naming generations (3.5 mid-tier aliases, 3.6 explicit suffixes). Account reality check 2026-08-16: this account's CCA `:fetchAvailableModels` still returns the six 3.6-era models only, so live requests must wait for Google's rollout; live discovery keeps governing selectability and unknown future ids stay identity-mapped.
- `defaultModel` for google-antigravity stays `gemini-3.6-flash` (convention: account-verified reality beats official-docs absence for OAuth-plan models). Revisit when CCA serves the 3.7 tiers.
- Runtime note: `google/gemini-3.7-flash` is already served through TokenRouter (Gemini endpoint type, listed 2026-08-13) and verified end-to-end through the proxy (see 010).

## xAI side-note (not in this unit's diff)
grok-4.6 launched 2026-08-12; OFFICIAL docs https://docs.x.ai/developers/grok-4-6 — 500,000-token context, $2/$6 per M. Used only for the tokenrouter runtime context-window hint; the `xai` bundle entry is a separate vendor-lane refresh.
