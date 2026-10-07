# Spoken audio

Use `voice-design` for a new voice take from `--text` and `--voice-description`;
use `voice-clone` for a new take from `--text` and an approved `--audio` reference.
The clone endpoint may accept `--reference-text`; inspect the live schema for
required fields and optional language. Pass role media directly to the CLI.

Separate the spoken script from tone and delivery directions. Reuse an approved
voice reference when continuity matters across takes; a single narration request
needs no persona registry. Preserve requested language and script meaning.

Text translation plus speech synthesis does not itself provide time-aligned
dubbing, preserve speaker timing or edit an existing recording. Do not advertise
voice conversion, music or sound effects through these endpoints. For a lip-sync
request, obtain actual completed audio and use a compatible video route.

Review pronunciation, pacing, naturalness and, for cloning, reference voice
continuity. For a narrated scene, measure the actual take rather than imposing an
English word-count rule on every language. Follow the shared execution, approval,
recovery and download rules; preserve the run handle and result file.
