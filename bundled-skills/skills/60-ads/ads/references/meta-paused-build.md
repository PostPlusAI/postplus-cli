# Build and preview a paused Meta campaign

Use this path for an authorized new website-conversion campaign with ad-set
budgets and single-image ads. Read the current schemas and availability first.
If a deployment reports `meta_build_not_enabled`, name that preparation gap;
do not invent fields on another tool or claim the account lacks permissions.

## Agree the complete configuration

Resolve account, Page, Pixel, website event, destination, currency, schedule,
per-group budget, total planned budget, audience and image for each ad. Keep
primary text, headline, description, CTA and tracking labels separate. Save the
agreed plan before creating objects. Creation authorization is distinct from
authorization to spend on delivery.

This path supports ordinary ad categories, website LEAD / PURCHASE /
COMPLETE_REGISTRATION conversions, CNY / USD / BRL, and ad-set-owned daily or
lifetime budgets with sharing disabled. Discover further support from the
schema. Never select an ordinary category to bypass a regulated requirement.

## Create one step at a time

| Step | Tool | Preserve from the successful result |
| --- | --- | --- |
| Upload the image | `METAADS_UPLOAD_AD_IMAGE` | Image hash in the exact account. Supply an owned PostPlus file reference in the `image` media slot; never manufacture a storage key. |
| Create paused campaign | `POSTPLUS_METAADS_CREATE_PAUSED_CAMPAIGN` | Verified campaign ID, no campaign budget, sharing false. |
| Create each paused ad set | `POSTPLUS_METAADS_CREATE_PAUSED_ADSET` | Verified ID, accepted targeting, schedule and budget. |
| Create each image creative | `POSTPLUS_METAADS_CREATE_IMAGE_CREATIVE` | Verified creative ID and independent copy fields. |
| Create each paused ad | `POSTPLUS_METAADS_CREATE_PAUSED_AD` | Verified ad ID referencing that creative and ad set. |
| Inspect saved object | `POSTPLUS_METAADS_READ_BUILD_OBJECT` | Current account, parent IDs, status and configuration. |
| Preview paused ad | `POSTPLUS_METAADS_PREVIEW_AD` | Preview URLs for the selected format. |

Use the exact `ad_account_id` target for every PostPlus build tool. The shared
service checks ownership and parent state. Creation is fixed to PAUSED; there
is no activation parameter. A new operation is not a retry mechanism.

## Money and audience meaning

Pass `budget: {"currency":"CNY","kind":"lifetime","amount":"250.00"}`
for a total CNY 250 ad-set budget. Do not pass 25000, pre-convert units, derive
daily budget from a lifetime amount, or silently exchange currency. Three such
groups total CNY 750.00. Start and end include a timezone; preserve the agreed
five-day interval. A daily budget is not a hard daily spending ceiling. This
contract does not establish units for older campaign-update tools.

Use real interest IDs and geography keys from discovery, selected by meaning.
Within a `flexible_spec` group detailed conditions are alternatives; separate
groups express narrowing conditions. Preserve the grouping rather than
flattening it into one interest list. Keep geography, locale IDs, ages,
placements and excluded custom audiences separate. Unsupported detailed-interest
exclusions cannot be substituted for custom-audience exclusions.

Explain Meta's expansion and obtain acceptance before setting
`accept_platform_audience_expansion: true`. An `advantage_audience` of 0 does not
establish that interests are hard delivery limits. Report requested conditions,
accepted configuration and platform optimization behavior separately.

## Copy, tracking and delivery

The creative tool accepts `primary_text`, `headline`, `description`,
`call_to_action`, `destination_url`, `image_hash`, `url_tags`. The latter is a
query string containing exactly one nonempty value for each of `utm_source`,
`utm_medium`, `utm_campaign`, `utm_content`, `utm_term`. Keep these labels out of
the destination URL to avoid duplicate values. Reuse the existing campaign
label convention; a Pixel event does not establish registration, subscription
or MCP activation in the product's own business records.

Present each verified ad's copy, destination, budget, targeting, schedule, IDs
and preview. Show preview URLs using the host's supported link or frame UI;
never execute upstream HTML. Keep preview URLs private. A preview is not ad
review approval or delivery.

## Resume without duplicate creation

Keep the first result and original operation ID for every step. A successful
creation receipt retains only `createdResource` identity, not the business
response. If readback fails after creation, inspect that recorded ID with the
read tool. Unknown outcomes without an ID require checking the original
operation and provider evidence; never assign a new ID to repeat an uncertain
write.

Continue from confirmed uploaded hashes and created IDs. Do not recreate prior
successful steps after a later failure. Report configuration differences instead
of silently changing the plan. Finish at paused objects and previews. Future
activation requires a separately supported action and explicit delivery approval.
