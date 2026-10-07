# Cartoon Ad

## Purpose

Create or audit animated ads that make the advertising argument visible. Use a coherent visual system to connect specific pressure, offer interaction, mechanism, proof, and a changed human state.

Treat `cartoon` as a storytelling system, not a named studio look or a requirement to be cute, childish, comedic, or metaphorical.

## Create Workflow

### 1. Ground The Brief

Read the smallest useful source context first:

- offer facts, audience, brand voice, claim boundaries, and available proof
- provided product, persona, UI, audio, brand, or reference assets
- prior ad analysis when explicitly relevant
- duration, aspect ratio, model, resolution, and output preferences when supplied

Lock:

- `offer_type`: `physical_product | software | service | community | content`
- `offer_capability`
- `specific_pressure`
- `desired_visible_state`
- `audience`
- `offer_interaction`
- `proof_available`
- `claim_boundaries`
- `visual_medium`
- `duration_and_format`

Do not invent medical, physiological, comparative, ingredient, price, review-count, performance-duration, or guarantee claims.

### 2. Design The Cartoon Grammar

Read [narrative grammar](narrative-grammar.md) and [metaphor and proof](metaphor-and-proof.md).

Choose one primary narrative engine and one visual-argument mode. Produce a `Cartoon Grammar Plan` with exactly these fields:

- `core_human_state`
- `specific_pressure`
- `narrative_engine`
- `offer_type`
- `pressure_carrier`
- `visual_argument_mode`
- `visual_argument_system`
- `character_system`
- `camera_and_edit_grammar`
- `offer_entry`
- `offer_interaction`
- `mechanism_trace`
- `proof_plan`
- `continuity_locks`
- `final_state_and_close`

State `Claim Boundaries` immediately after the plan. Do not force a metaphor, fixed shot order, character type, material style, joke, product category, or ending formula.

### 3. Write The Shot Script

Read [shot script rubric](shot-script-rubric.md) and [continuity rules](continuity-rules.md).

Return a shot table with exactly these columns:

`time | visual | framing/composition | camera motion | action | offer/prop relationship | lighting/color | sound | speech/text | purpose`

After the table, provide:

- `Continuity Locks`
- `Proof Status`
- `Claim Boundaries`
- `Causal Closure Gate`

Keep each shot concrete enough for still generation, video prompting, or animation production. Give each shot one dominant action and one causal idea.


## Quality Bar

- Open on specific pressure and use one coherent `visual_argument_system`.
- Show plausible offer interaction, mechanism trace, and causal result behavior.
- Treat aspirational peers as illustration, not proof; use approved proof layers.
- End on an embodied human state and keep one main idea per shot.
- Add exact packaging, legal, numeric, UI, and subtitle text in post.

## Non-Imitation Boundary

- Do not copy reference characters, creator identity, brand marks, exact scenes, package designs, signature jokes, or recognizable story devices.
- Do not prompt for a named animation studio or living creator's style.
- Translate references into generic production attributes: material, proportions, expression range, lighting, camera behavior, edit rhythm, visual argument, and proof logic.

For multi-scene narration, pass the approved script to `$generate` and use its
narrated-video branch for shared style and scene/audio pairing. Do not assume
a final-film assembly capability or force ten-second scenes.
