# Execute an own-account social task

Use the PostPlus CLI for connected account reads and writes. This is the
common procedure; use the selected platform reference for the actual request
fields. Public content research does not require a channel connection.

## Select the connection and tool

```sh
postplus channels list --json
postplus channels tools list --toolkit <instagram|facebook|linkedin|twitter|youtube|tiktok|reddit|pinterest> --query <task> --json
postplus channels tools show <FULL_TOOL_SLUG> --json
```

Reuse the connection that belongs to the user and matches the requested
channel. If none exists, `postplus channels connect <channel-id> --json`, then
`postplus channels wait <connection-id> --json`; valid social IDs are
`instagram`, `facebook`, `linkedin`, `x`, `youtube`, `tiktok`, `reddit`, and
`pinterest`. Continue the original task after connection. A connected toolkit
does not establish Page, organization, board, community, or publishing
permission. Inspect the selected tool's current `show` result for enabled
state, required fields, target policy, and enum values. If the tool is
disabled, permission fails, or the target cannot be resolved, stop and report
the actual gap. Do not switch to an unreviewed nearby tool as a workaround.

Use a read tool to discover the exact external account or object. IDs from one
channel or personal/organization identity are not interchangeable. Write the
request as JSON in a local file. For a tool whose `show` contract requires an
external target, pair `--target-id <actual ID>` with `--target-path <JSON
argument path>` and make the JSON field equal the ID. For a single-target
write under an argument-bound policy, prefer the same explicit binding when a
scalar account or object field identifies that target. A connection target is
accepted for other argument-bound requests; never invent a field solely to
attach a target pair.

## Use the declared billing mode

Connection management and tool-directory discovery do not charge X execution
credits. An eligible personal subscription unlocks channel access; X execution
uses the selected workspace's existing PostPlus credits under the current
server pricing. Other channels retain their declared billing mode. Read the
server's pricing and result fields; do not calculate provider rates or duplicate
a price table in this Skill.

For the server's current quote, use the same inputs before submission:

```sh
postplus channels tools run <FULL_TOOL_SLUG> --connection <own-connection-id> --input-file request.json --estimate --json
```

Include the same target and media-map flags when required by the task. An
estimate does not execute platform work, reserve credits, or create a run. If
pricing is unavailable, report the returned pricing gap; do not assume zero
cost or bypass the quote.

Use existing task and spending authorization. Do not add a payment-confirmation
step for every requested task. Do not recharge or buy a subscription automatically.
Insufficient credits stop before platform submission. A credit reservation is
not a settled charge or a caller-enforced final-cost cap. Keep the original
operation ID when execution or billing is unresolved; a new request is not a
way to recover the original task.

## Submit once and keep the first result

```sh
postplus channels tools run <FULL_TOOL_SLUG> --connection <own-connection-id> --input-file request.json --operation-id <stable-operation-id> --wait --json > result.json
```

Before a write, check final account, destination, parent object, text, media,
link, visibility, and any schedule against the user's actual instruction.
Authorization to connect or read is not authorization to post. If the user has
already authorized this exact content and destination, proceed; otherwise get
the missing choice before sending. The first response and operation ID are
part of the evidence. If execution or billing remains unresolved, use
`postplus channels tools run --status <same-operation-id> --json`. The status
endpoint only reports lifecycle; it does not recreate the first full business
result. Never retry a possibly completed write under a new ID. Platform
accepted, processing, published/visible, and unknown are different outcomes.
Read the returned platform object with a separate exact-object tool when
available; a successful CLI submit does not prove final public visibility.

For a local video, first use `postplus media-file upload --input-file
./video.mp4 --output media-result.json`. Put its actual `postplus-media://`
reference in a media-map JSON keyed by the file input path, then add
`--media-map-file map.json` to `channels tools run`. Do not hand-fill the
tool's `file_uploadable` object or an internal storage key in request JSON.
See [YouTube/TikTok](youtube-tiktok.md) for `videoFile` versus
`file_to_upload`. A public URL input is a separate route and must be readable
by the platform.

For review, compare only like-for-like account scope, time interval, timezone,
metric meaning, and completeness. A missing permission, sparse response, or
still-processing item is evidence of a limit, not permission to fabricate a
metric. Save the source result and state what was actually verified.
