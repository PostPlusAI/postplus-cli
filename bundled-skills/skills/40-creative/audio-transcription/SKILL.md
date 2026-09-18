---
name: audio-transcription
description: Transcribe local or remote audio into durable text and timestamp artifacts through PostPlus. Use this when the job is speech-to-text from audio files and you need request/response persistence, optional timestamps, and subtitle-ready outputs.
metadata:
  postplus:
    familyId: media-production
    familyName: Media and Creative Production
---

# Audio Transcription

## Use When
- The input is audio and the main job is speech-to-text, subtitle-ready timing,
  rough speech search, multilingual transcription, or durable transcript
  artifacts.
- Use `video-transcription` for video inputs and `media-analysis` for semantic
  video understanding.

## Do Not Use When
- The task belongs to ideation, QA, or another released skill listed in the handoff section.
- Required inputs are missing and guessing would change the result.

## Execution Boundary
- Hosted transcription runs through the public `postplus media transcribe` verb
  and is async. A submit records the run handle, current status, and completed
  artifacts when available.
- Pass a local path, HTTPS URL, existing PostPlus media reference, or data URI
  directly to `--audio`. The CLI validates and prepares local media before the
  single hosted submit.
- A higher-quality default model and a faster, cheaper variant are available;
  prefer the default when subtitle quality matters and use the cheaper variant
  for an explicit rough pass. The generated example below shows the default
  endpoint key.

## Source And Path
- Supply the media duration so PostPlus can validate the request before it runs;
  a missing duration fails before submission.
- Request timestamps when the output will feed subtitles or edit decisions.
- Start with one source file or audio URL before larger batches.
- Keep internal requests, responses, manifests, normalized transcripts, and
  downloaded artifacts under `.postplus/audio-transcription`; keep final
  user-facing transcript exports outside `.postplus`.

## Handoff
- If status is pending, return the manifest path, the `output.data.id` generation
  handle, and the poll command `postplus media poll --handle <output.data.id>`
  (waits in-command up to 45s per invocation; rerun while pending). Do not keep
  the conversation open just to poll.
- When completed, hand off downloaded artifacts and `normalizedTranscriptPath`
  to `subtitle-packager` if SRT/ASS is needed.

## Stop Conditions
- Stop when required user intent, source evidence, or owned input artifacts are
  missing and guessing would change the result.
- If an owned CLI or script command still fails after any bounded recovery allowed by the executing PostPlus skill, report the exact error and stop. Do
  not bypass the failure with metadata-only answers, readiness probing, local
  payload rewrites, alternate execution paths, or unpublished tools.

## Public Command Boundary

- Choose the smallest matching command or workflow from the user input and run
  it directly.
- Readiness diagnostics: `postplus doctor --skill audio-transcription`.
- If an owned CLI or script command still fails after any bounded recovery allowed by the executing PostPlus skill, report the exact error and stop. Do
  not bypass the failure with metadata-only answers, readiness probing, local
  payload rewrites, alternate execution paths, or unpublished tools.
- Use `postplus media schema --json` only when you need the full endpoint, flag,
  and enum contract or are repairing an unknown request shape.
- Run the hosted transcription job with the generated command below; do not use
  another execution interface.
- Pass the source directly through `--audio`; do not pre-upload it or construct
  a manual request object.

<!-- BEGIN GENERATED EXECUTION EXAMPLE -->
```bash
postplus media transcribe transcription \
  --audio ./reference.wav \
  --duration-seconds 1 \
  --wait \
  --output ./result.json
```

**Bounded recovery:** Current PostPlus CLIs perform one compatible update and one task retry when no agent-session restart is required. Count a CLI-managed automatic update toward the one allowed recovery attempt. Only if an older CLI reports an update requirement without attempting recovery, run `postplus update` once; retry the task only after success and when no restart is required. Update is auth-independent. If maintenance or that retry fails, stop and report its error; a suggested action is not permission for a second automatic update or task retry.

For a missing or invalid CLI session, run `postplus auth login` yourself; share its exact browser URL for the user to **Connect**, and retry once only after CLI-confirmed success. Never approve the connection for the user, expose polling secrets, or automatically restart a cancelled/expired login. Track login and compatibility recovery separately for the same task; neither resets the other's used allowance, and a failed recovery stops the task. A local usage rejection before remote work may be corrected once using the current command's help and existing user input.

For `postplus_cli_balance_required` with an `open_url` user action, share its exact label and URL and wait for account action. Do not invent checkout links or blindly resubmit after payment. Continue existing work only through its documented status or checkpoint. Never resubmit when remote work may have started, bypass approval, change intent or switch providers to hide failure. Mention an update only when the CLI actually reports one.
<!-- END GENERATED EXECUTION EXAMPLE -->

- If the CLI returns a quote-confirmation challenge, run `postplus quote confirm --json --challenge-file <challenge.json>` and retry with the returned token.
