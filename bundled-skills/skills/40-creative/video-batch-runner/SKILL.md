---
name: video-batch-runner
description: Generate one or many videos through PostPlus from a brief, script, prompt, image, audio, or reference video. Use for text-to-video, image-to-video, first/last-frame video, multimodal reference video, talking-head video, and motion transfer. The agent chooses the matching released endpoint from current schema, writes one self-contained prompt per clip, submits media by role, waits or resumes, downloads, and hands the render to QA.
metadata:
  postplus:
    familyId: media-production
    familyName: Media and Creative Production
---

# Video Batch Runner

This is the single PostPlus video-generation skill. It owns creative request
assembly and execution across released video models; do not create a separate
architect, preflight report, reference contract, or model-specific submitter.

## Workflow

1. Read the brief and inspect the supplied media. Use `media-analysis` first only
   when understanding an existing video materially changes the new render.
2. Run `postplus media schema --json`, choose the smallest released endpoint
   whose input roles match the job, then load its exact fields with `postplus
   media schema --endpoint <endpoint> --json`:
   - no driving media: text-to-video
   - one opening image: image/first-frame-to-video
   - locked opening and closing images: first-last-frame-to-video
   - several images, videos, or audios that guide the result: reference video
   - change an existing video's content: video edit
   - continue an existing video: video extend
   - portrait plus approved audio: talking head
   - identity image plus motion source video: motion transfer
3. Decide each asset's role from the task. Bind identity, product, first/last
   frame, timing, or motion only when the asset must control that property. Treat
   style and benchmark media as inspiration, and omit media that should not
   influence the render. Never infer a role merely because a file is present.
4. Write one self-contained, model-facing prompt per clip. Include the visible
   subject and action, product behavior, scene, camera, timing, speech/sound,
   continuity, and the role of every submitted reference. Use explicit
   `[image N]`, `[video N]`, and `[audio N]` bindings when the selected endpoint
   accepts numbered references.
5. Validate fields, enum values, defaults, cardinality, and duration against the
   current schema. Do not carry private execution field tables in this skill. If one clip
   exceeds the supported duration or creative load, split it into independent
   prompts before spending.
6. Pass each local path, HTTPS URL, existing PostPlus media reference, or data
   URI directly to the matching role flag. The CLI validates and prepares local
   media before a single hosted submit. Use only fields published by the
   selected endpoint; do not pre-upload media or construct private payloads.
7. Prefer `--wait` when the expected runtime fits the command budget. If create
   still returns pending, poll the same run with `postplus media poll
   --handle <output.data.id>`. Re-run that poll while pending; never submit a
   replacement request merely to check status.
8. When a local final file is needed, download the completed output with
   `postplus media-file download --url <fresh-output-url> --output-file <path>
   --skill video-batch-runner`.
9. Return the actual result, downloaded media or result path, endpoint, prompt,
   submitted media roles, and run handle. Send the finished render to
   `media-analysis` or `creative-qa` only when final media QA is requested.

## Execution Rules

- PostPlus schema is the source of truth for endpoint availability, input
  fields, enums, and defaults.
- Use the released `postplus` CLI. Do not call underlying services directly,
  invent private fields, or create a service-specific submitter skill.
- Keep private request/result files under the active work folder's `.postplus/`
  state; do not manufacture contract or planning artifacts for handoff.
- If the CLI returns a quote-confirmation challenge, show it to the user, run
  `postplus quote confirm --json --challenge-file <challenge.json>` only after
  approval, then retry the exact operation with the returned token.
- On an auth, transport, quota, malformed-request, capability, or execution
  failure, report the typed error and stop. Do not switch endpoints, rewrite the
  request, or claim a local plan is an executed render.
- In a batch, only the typed error
  `postplus_cli_hosted_media_content_policy_blocked` is item-local: record that
  item as blocked without rewriting or retrying it, continue the independent
  items, and report the incomplete set. Every other error stops the batch.

## Public Command Boundary

- Readiness: `postplus doctor --skill video-batch-runner`
- Discover endpoints: `postplus media schema --json`
- Read selected endpoint fields: `postplus media schema --endpoint <endpoint>
  --json`
- Submit local or remote role media directly: `postplus media create <endpoint>
  --skill video-batch-runner ... --wait`
- Resume: `postplus media poll --handle <output.data.id>`
- Download: `postplus media-file download --url <fresh-output-url> --output-file
  <path> --skill video-batch-runner`

<!-- BEGIN GENERATED EXECUTION EXAMPLE -->
```bash
postplus media create video-kling-v3-0-pro-text \
  --prompt "Describe the result you need" \
  --wait \
  --output ./result.json
```

**Bounded recovery:** Current PostPlus CLIs perform one compatible update and one task retry when no agent-session restart is required. Count a CLI-managed automatic update toward the one allowed recovery attempt. Only if an older CLI reports an update requirement without attempting recovery, run `postplus update` once; retry the task only after success and when no restart is required. Update is auth-independent. If maintenance or that retry fails, stop and report its error; a suggested action is not permission for a second automatic update or task retry.

For a missing or invalid CLI session, run `postplus auth login` yourself; share its exact browser URL for the user to **Connect**, and retry once only after CLI-confirmed success. Never approve the connection for the user, expose polling secrets, or automatically restart a cancelled/expired login. Track login and compatibility recovery separately for the same task; neither resets the other's used allowance, and a failed recovery stops the task. A local usage rejection before remote work may be corrected once using the current command's help and existing user input.

For `postplus_cli_balance_required` with an `open_url` user action, share its exact label and URL and wait for account action. Do not invent checkout links or blindly resubmit after payment. Continue existing work only through its documented status or checkpoint. Never resubmit when remote work may have started, bypass approval, change intent or switch providers to hide failure. Mention an update only when the CLI actually reports one.
<!-- END GENERATED EXECUTION EXAMPLE -->
