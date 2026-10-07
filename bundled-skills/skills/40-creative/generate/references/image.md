# Image creation and editing

Classify the actual task: text-to-image, image edit, reference-bound image,
product image, banner/thumbnail, storyboard panel, or batch variant. Classification
is internal; do not require the user to complete a controller form.

Use `image-gpt-image-2-text` for ordinary text generation and
`image-gpt-image-2-edit` for reference-bound work unless the request calls for
another supported family. Read the selected endpoint schema for its exact options.
Only edit endpoints accept `--reference-image`; repeat that flag per reference.
Text endpoints reject it. Preserve the user's model choice when supported.

## Write the prompt

Describe the subject, setting and visual medium, with specific camera, lighting
and composition details when they change the result. Prefer concrete visible
properties to generic quality adjectives. There is no universal token limit.

For edits, describe what changes and what stays locked instead of retelling the
entire source image. For example, replace “a bottle on a counter, but in winter”
with “keep the bottle geometry, label and color; change the surrounding counter
scene to soft winter morning light.” Never discard the product/identity locks
merely because the source image already contains them.

Use affirmative visual targets where clearer: “sharp subject edges” instead of
“no blur”. Do not invent a negative-prompt flag absent from the endpoint schema.

## Reference and output decisions

A product/identity reference constrains those attributes. A style donor supplies
rendering or color, not its people, marks or objects. Inspiration-only examples
need not be submitted. Explain a conflict between requested edits and locked
attributes before spending rather than silently overriding either.

Use approved product and brand facts when relevant. A simple illustration needs
no persona registry or benchmark. For a banner, plan space for the intended copy;
for storyboards, preserve shot order and character/product continuity. Thumbnail
concepts use [thumbnail frameworks](thumbnail-frameworks.md) only when needed.

For variants, vary a named creative axis such as angle, setting or lighting while
holding required brand/product attributes fixed. A carousel needs a shared visual
system across panels. Batch execution, canary, polling and download follow the
entrypoint; do not treat accepted submissions as finished images.

Review requested changes, geometry, text legibility where relevant and continuity.
Deliver the actual output and flag defects rather than claiming exact reproduction.
