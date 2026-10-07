---
name: generate
description: Create or edit images, generate videos, and synthesize or clone voices from a request and supplied references. Handle single outputs or batches and return actual media results.
metadata:
  postplus:
    familyId: media-production
    familyName: Media and Creative Production
---

# Generate

Own the request from creative input to completed media. A ready prompt or approved
script goes directly to execution; a simple request needs no campaign brief,
persona registry, benchmark report, or separate planning Skill.

## Select the work

Read only the relevant branch:

- Images, edits, product images, storyboard panels or variants: [image](references/image.md).
- Video, first/last frames, references, edits, extensions, talking heads or motion: [video](references/video.md).
- Spoken audio, voice design or an approved voice reference: [voice](references/voice.md).
- Thumbnail concepts: [thumbnail frameworks](references/thumbnail-frameworks.md).
- Multiple narrated scenes needing a consistent style: [narrated video](references/narrated-video.md).

Use `$ad-creative` when the user needs advertising direction or a script, not
when they already supplied one. Use `$media-analysis` only when understanding
existing media materially changes this task. Transcription belongs to
`audio-transcription` or `video-transcription`. Music, sound effects, synchronized
translation dubbing, voice conversion and automatic final-film assembly are not
promised by the voice-design/voice-clone generation paths.

## Prepare and execute

1. Resolve the requested output and only missing inputs that materially affect it.
   Preserve the user's chosen model, assets, claims and approved creative choices.
2. Choose the supported endpoint whose inputs match the task. Discover unknown
   options with `postplus media schema --json`, then read the selected contract
   with `postplus media schema --endpoint <endpoint> --json`. Schema owns fields,
   requiredness, defaults, enums, reference counts and duration limits.
3. Bind assets by their intended role: identity, product, first/last frame,
   motion, timing or style. A file's presence does not establish its role.
   Exclude inspiration-only media from execution unless it should guide the result.
4. Write a self-contained prompt per output. Split unsupported duration or excessive
   creative load before spending. Preserve approved facts and continuity locks.
5. Pass each local path, HTTPS URL, existing PostPlus media reference or data URI
   directly to the matching role flag. The CLI validates and prepares local media
   before a single hosted submit; do not pre-upload or construct private envelopes.
6. Use `postplus media create <endpoint> --skill generate ... --wait` when the wait
   fits the command budget. If pending, poll the same run with the returned action
   or `postplus media poll --handle <output.data.id> --output <initial-result-path>`.
   A completed poll atomically replaces the processing JSON. Reuse its result path and honor the CLI's wait/recovery boundary. Never submit
   a replacement merely to check status.
7. Download completed media with `postplus media-file download --reference
   <output.data.artifacts[0].mediaReference> --output-file <path> --skill generate`, or use
   `--url <completed-output-url>` when the result supplies an output URL instead.

Keep intermediate request/result state under the active work folder's `.postplus/`;
keep final media in the chosen output folder. Identifiers come from CLI results.
Use `postplus doctor --skill generate` after a readiness failure, not as a routine
extra step for every output.

<!-- BEGIN GENERATED EXECUTION EXAMPLE -->
```bash
postplus media create image-gpt-image-2-text \
  --prompt "Describe the result you need" \
  --wait \
  --output ./result.json
```

Follow the CLI's structured result and reported next action; do not infer recovery from free-text messages.
Wait for explicit user approval when requested; an action does not authorize spending, publishing, or overwriting.
Resume the same operation through its returned checkpoint or action; never resubmit uncertain work, repeat exhausted recovery, or switch providers to bypass failure.
<!-- END GENERATED EXECUTION EXAMPLE -->

## Authorization and failures

Honor quote challenges using existing explicit authorization when it covers the
scope and cost; otherwise obtain approval. Use the returned `postplus quote confirm
--json --challenge-file <challenge.json>` and fixed retry command with its token
and original operation identity. A retry is not permission to change the request.

For a batch, complete one canary before submitting the independent remaining items.
Only `postplus_cli_hosted_media_content_policy_blocked` is item-local, whether
returned by create or in a failed poll result's error code. Record and skip that
item without rewriting or retrying it; if it was the canary, test the next item
before fan-out. Report the incomplete set. Every other auth, transport, quota,
request or execution failure stops the batch; do not silently switch models.
Dependent scenes must not continue as if a missing prerequisite succeeded.

## Deliver

Check completed media against the request: identity/product fidelity, requested
change or action, continuity, sound and usable output. Return actual media or
saved files, along with material limitations. Keep endpoint, prompt, input roles
and run handle available in saved results. A submitted handle is not finished media.
Deeper analysis is optional. If the user asked for a complete multi-scene film,
verify an available composition path first; loose clips do not satisfy that request.
