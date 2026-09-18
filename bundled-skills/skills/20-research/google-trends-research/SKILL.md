---
name: google-trends-research
description: Research Google Trends search-intent signals for topic discovery, keyword momentum, regional interest, and rising queries without treating search trends as the same thing as platform content heat or marketplace demand.
metadata:
  postplus:
    familyId: marketplace-sourcing
    familyName: Marketplace, Sourcing, and Growth
---

# Google Trends Research

Use this skill for Google Trends platform-data work: topic discovery, keyword
momentum, regional interest, rising queries, and search-intent watchlists.

Apply shared rulebook and user-guidance rules from `postplus-shared`.
When a supported command completes but evidence is empty, sparse, noisy,
off-topic, or the wrong record type, apply the `postplus-shared` reference
`research-quality-recovery.md`; hard execution errors still fail fast.

## Core Rule

Treat Google Trends as a search-intent source, not full demand proof.

Good uses: topic discovery, keyword momentum, regional comparison,
rising-query discovery, and watchlist monitoring.

Do not overclaim transaction demand, conversion intent, marketplace
competitiveness, creator execution quality, or merchant-model fit from Google
Trends alone.

## Task Shapes

Classify the request first:

- Trending now scan: hot searches by country or recent lookback.
- Keyword momentum check: trend changes across one or more terms.
- Regional interest mapping: which markets are warmer for a topic.
- Related query expansion: rising terms usable as seeds.

## Route

Use `google-trends-fast` with one `--query`, a country, and a time range.
PostPlus locks the route to keyword analysis so the Agent only supplies research
intent.

<!-- BEGIN GENERATED EXECUTION EXAMPLE -->
```bash
postplus research run google-trends-fast \
  --query "example topic" \
  --wait \
  --output ./result.json
```

**Bounded recovery:** Current PostPlus CLIs perform one compatible update and one task retry when no agent-session restart is required. Count a CLI-managed automatic update toward the one allowed recovery attempt. Only if an older CLI reports an update requirement without attempting recovery, run `postplus update` once; retry the task only after success and when no restart is required. Update is auth-independent. If maintenance or that retry fails, stop and report its error; a suggested action is not permission for a second automatic update or task retry.

For a missing or invalid CLI session, run `postplus auth login` yourself; share its exact browser URL for the user to **Connect**, and retry once only after CLI-confirmed success. Never approve the connection for the user, expose polling secrets, or automatically restart a cancelled/expired login. A local usage rejection before remote work may be corrected once using the current command's help and existing user input.

For `postplus_cli_balance_required` with an `open_url` user action, share its exact label and URL and wait for account action. Do not invent checkout links or blindly resubmit after payment. Continue existing work only through its documented status or checkpoint. Never resubmit when remote work may have started, bypass approval, change intent or switch providers to hide failure. Mention an update only when the CLI actually reports one.
<!-- END GENERATED EXECUTION EXAMPLE -->

## Default Workflow

1. Classify the request into one task shape.
2. Compile one keyword with country and timeframe.
3. Collect a small valid sample through `google-trends-fast`.
4. Extract trend signals that matter.
5. Separate observation from inference.
6. Hand off to platform or marketplace research if deeper evidence is needed.

The result record shape for the route is documented in the
`postplus-shared` reference `dataset-item-schemas.md`; consult it before
writing result-processing code, and probe a single record only to verify.

Keep query briefs, raw trend payloads, normalized outputs, and watchlist caches
under `.postplus/google-trends/`; keep final summaries or shortlist exports
where the user can inspect them.

## Good Output

Return keyword or topic set, observed trend signal, timeframe, geo scope,
strongest rising queries or related topics, provisional implication, and the
missing evidence layer.

## Failure Modes

- Do not treat search spikes as proof that a product will sell.
- Do not confuse news-driven spikes with durable category demand.
- Do not skip geo and timeframe details when comparing terms.
- Keep each run to one clear keyword; compare multiple terms as separate bounded
  runs.
- Stop on unsupported keys, missing auth, unavailable hosted service, stable
  network failure, or malformed collection output.
- Do not answer Google Trends platform-data requests from generic web articles
  when the hosted route is available.

## Handoff

- TikTok content heat or hook patterns -> `tiktok-research`.
- Instagram creator, account, or campaign scouting ->
  `instagram-research`.
- Instagram/Meta content proof -> `social-media-extractor`.
- Cross-source sourcing or selection judgment -> `sourcing-selection`.

## Public Command Boundary

- Choose the smallest matching command or workflow from the user input and run
  it directly.
- Readiness diagnostics: `postplus doctor --skill google-trends-research`.
- If an owned CLI or script command still fails after any bounded recovery allowed by the executing PostPlus skill, report the exact error and stop. Do
  not bypass the failure with metadata-only answers, readiness probing, local
  payload rewrites, alternate services, or unpublished tools.
- Inspect flags with `postplus research run google-trends-fast --help` only when
  needed.
- Run `postplus research run google-trends-fast --query <term> --country <code>
  --time-range <window> --wait --output <result.json>`.
- Preview and approval boundaries stay explicit; do not execute irreversible publishing without the required approval artifact.
- If the CLI returns a quote-confirmation challenge, run `postplus quote confirm --json --challenge-file <challenge.json>` and retry with the returned token.
