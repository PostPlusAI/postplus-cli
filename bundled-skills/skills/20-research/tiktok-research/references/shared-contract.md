# TikTok Shared Contract

This is the public TikTok route and evidence contract. PostPlus owns execution,
credit guards, and polling.

## Routes

| Evidence need | Route | Semantic input | First pass |
| --- | --- | --- | --- |
| Organic videos | `tiktok-videos` | query/handle/hashtag/URL, country, limit | 20 videos |
| Comments/audience voice | `tiktok-comments` | repeat `--url`, `--limit` | 1-5 videos, 20 comments |
| Known profiles | `tiktok-profiles` | repeat `--handle`, `--limit` | 1-5 profiles |
| Account recall | `tiktok-users` | repeat `--query`, `--limit` | 20 accounts |
| Related videos | `tiktok-related-videos` | repeat `--url`, country, limit | 20 videos |
| Paid examples | `tiktok-ads-top` | `--limit` | 20 ads |

Run:

```bash
postplus research run <route> --<semantic flags> --wait --output result.json
```

Use `postplus research run <route> --help` only when needed.

TikTok Shop, LIVE, private analytics, backend audience data, hidden contacts,
GMV, targeting, spend, ROAS, music archive download, and audio extraction are
outside this surface.

## Human Alignment

Infer the decision: account diagnosis, organic benchmark, audience voice,
creator discovery, paid creative, campaign scouting, product-content fit, or
market localization. Ask one question only when it changes the route, privacy
boundary, sample, or deliverable.

## Common Chains

- Account audit: profiles first; videos only when content evidence is needed.
- Audience voice: shortlist videos, then collect comments from selected URLs.
- Creator discovery: video/search evidence first, then verify profiles.
- Paid vs organic: run separate routes and never mix the evidence lanes.
- Localization: one bounded video route per market/language, clearly labeled.

## Bounds And Recovery

- Start with one route and a small sample; keep each seed/market attributable.
- Execution failures follow `postplus-shared/references/shared-public-skill-rules.md`; stop after its permitted recovery is exhausted. Successful but insufficient evidence follows `postplus-shared/references/research-quality-recovery.md` within the existing scope and budget.
- Resume with `postplus research run --resume-from result.json`; never resubmit.

## Evidence

Keep the complete JSON result and public URLs. Separate paid and organic,
observation and inference, and visible metrics from hidden performance. Return
scope, counts, representative evidence, limitations, artifact path, and one
useful next action.
