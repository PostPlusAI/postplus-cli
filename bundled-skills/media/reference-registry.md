# Media Reference Guidance

Reference roles are reasoning guidance, not an intermediate contract artifact.
The executing agent decides the role of each supplied asset from user intent and
approved upstream context, then expresses that decision directly in the final
prompt and request.

| Role | Use when | Action |
| --- | --- | --- |
| Binding | The render must preserve identity, product appearance, first/last state, timing, motion, voice, or approved continuity. | Submit it in the endpoint slot that controls that property and name its role in the prompt. |
| Inspiration | The task should learn structure, pacing, composition, camera grammar, tone, or mood without copying identity. | Use only if the selected endpoint can benefit from it; describe the transferable quality, not the source identity. |
| Omitted | The asset is rejected, unsafe, off-scope, a competitor identity, or has no clear job in this render. | Do not upload or submit it. |

Typical routes:

| Task | Optional preparation | Execution |
| --- | --- | --- |
| Image generation/edit | Read supplied assets; use media-analysis only when interpretation is needed | generate |
| Video from prompt, frames, references, audio or motion | ad-creative for requested strategy; media-analysis for requested reference breakdown | generate |
| Voice design or clone | Approved script and voice description/reference | generate |
| Talking-head video | Obtain actual completed approved audio when missing | generate, audio then video |

Use current PostPlus schema for endpoint availability, media cardinality, field
names, enums, and defaults. Omit a reference whose intended influence is unclear;
ask the user only when the ambiguity would materially change the render.
