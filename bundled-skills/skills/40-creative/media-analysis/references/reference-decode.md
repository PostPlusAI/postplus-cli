# Reference Decode

## Use When
- A benchmark video, contact sheet, frame set, rough idea, or source material
  needs to become promptable structure.
- You need the hook essence, viewer question, visual grammar, and forbidden
  drift before storyboard or request writing.
- A user explicitly asks for a brief-derived structure without reference material.

## Do Not Use When
- Do not create the final storyboard grid or execution request here.
- Do not copy faces, exact wardrobe, creator identity, exact location, or exact
  overlays from benchmark material.

Keep each reference linked to the supplied product/person context and the user's
intended reuse. Reuse an already inspected generated result when suitable; do not
pretend it is a real customer testimonial or require a hosted reference-library ID.

## Core Rule
Do not summarize references as "good vibe", "nice pacing", or "strong
chemistry". Extract four objects:

- `hookEssence`
- `viewerQuestion`
- `mustCopyVisualGrammar`
- `forbiddenDrift`

Use this branch only for a requested creative breakdown, not ordinary media analysis.

## Workflow
1. Use the smallest sufficient source set: hook-first clip, first 0-5 seconds,
   hook-first contact sheet, supporting note, or full style board only if needed.
2. Decode the opening mechanism: first clear promise, viewer question, and the
   exact visual structure that makes the promise legible.
3. Separate structure from identity. Keep camera grammar, shot order, object
   logic, timing, and relationship logic; do not keep exact identity details.
4. Create a compact decode artifact when it is useful.
5. Print or return the decode block before storyboard or request writing.

## No-Reference Mode
When no usable reference exists, operate in proxy mode:

- start from the chosen segment pattern
- infer the likely viewer question
- express must-copy grammar as scene anchors, not imitation notes
- express forbidden drift as anti-generic safeguards
- state that the output is brief-derived, not observed from footage

## Output Shape
The artifact contains `hookEssence`, `viewerQuestion`, `mustCopyVisualGrammar`, and
`forbiddenDrift`.

## Stop Conditions
- Stop when required user intent, source evidence, or owned input artifacts are
  missing and guessing would change the result.


## Handoff
- For a grid or panel plan, preserve the decoded evidence in the requested layout before image generation.
- Image generation -> `generate`.
- Video generation -> `generate`; pass the useful decoded grammar as
  context, not as a second contract file.
