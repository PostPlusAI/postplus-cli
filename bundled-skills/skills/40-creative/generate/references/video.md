# Video generation

Choose from the live schema by the inputs needed:

- Text-to-video: no driving media.
- First-frame/image-to-video: the supplied image anchors the opening.
- First-last-frame: both boundary frames must be controlled.
- Reference video: several permitted image/video/audio references guide output.
- Edit or extend: change an existing video or continue it.
- Talking head: portrait plus approved speech audio.
- Motion transfer: identity image plus a motion source video.

Do not substitute one role for another merely because both accept images. Inspect
`postplus media schema --endpoint <endpoint> --json` before an unfamiliar request.
For example, InfiniteTalk takes `--image` and `--audio`; do not borrow a duration
flag from another endpoint. First/last-frame flags belong to endpoints exposing them.

## Write each clip

Include subject, product action, scene, camera, timing, sound/speech, continuity
and the purpose of submitted references. Number references explicitly when the
selected endpoint supports numbered binding. Every clip must make sense on its own.

When an image anchors the opening, spend prompt space on what moves and changes:
“the hand lifts the bottle; condensation runs down its side; the camera slowly
pushes in.” Do not merely repeat the static frame. Keep identity/product locks
explicit and avoid asking for several unrelated actions in one short shot.

Use concrete verbs for subject and camera motion. A wide lens or dramatic camera
move is a creative choice, not a compulsory quality recipe. If the scene exceeds
the model's duration or action capacity, split before execution and identify the
requested deliverable: individual clips or a finished film.

## Continuity and sound

Lock only what the task needs: person, product, outfit, location, lighting or
opening/closing state. For narrated multi-scene work, read
[narrated video](narrated-video.md). Its animation-specific choices do not apply
to photoreal UGC or talking heads.

When feeding generated voice to a talking head, wait for the actual audio result,
download or reuse its supported reference, then submit it. A planned filename is
not an existing artifact. Check finished action, visible product behavior, audio
and continuity. Further media analysis is optional, not a compulsory paid step.
