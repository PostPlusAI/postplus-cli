# Shared Public Skill Rules

Shared execution rules for released PostPlus skills running inside the PostPlus runtime.

Use this rulebook when a skill needs PostPlus Cloud service access, temporary local
artifacts, or a compile step before hosted execution.

## PostPlus Cloud Rule

- Treat PostPlus Cloud auth, usage approval, and execution as the source of
  truth for hosted work.
- Do not probe local secret env vars or ask the user to paste service tokens
  into the chat just to see whether a capability exists.
- If the PostPlus Cloud boundary reports that a capability is unavailable or not
  configured, fail fast and report that directly to the user. A missing or invalid
  CLI session follows the bounded login handoff below; other authorization failures
  still fail fast.
- On that capability-missing path, do not switch into a “we can collect later”
  discovery flow.

## Bounded Client Recovery Rule

<!-- BEGIN PUBLIC CLI RECOVERY CONTRACT -->
**Bounded recovery:** Current PostPlus CLIs perform one compatible update and one task retry when no agent-session restart is required. Count a CLI-managed automatic update toward the one allowed recovery attempt. Only if an older CLI reports an update requirement without attempting recovery, run `postplus update` once; retry the task only after success and when no restart is required. Update is auth-independent. If maintenance or that retry fails, stop and report its error; a suggested action is not permission for a second automatic update or task retry.

For a missing or invalid CLI session, run `postplus auth login` yourself; share its exact browser URL for the user to **Connect**, and retry once only after CLI-confirmed success. Never approve the connection for the user, expose polling secrets, or automatically restart a cancelled/expired login. Track login and compatibility recovery separately for the same task; neither resets the other's used allowance, and a failed recovery stops the task. A local usage rejection before remote work may be corrected once using the current command's help and existing user input.

For `postplus_cli_balance_required` with an `open_url` user action, share its exact label and URL and wait for account action. Do not invent checkout links or blindly resubmit after payment. Continue existing work only through its documented status or checkpoint. Never resubmit when remote work may have started, bypass approval, change intent or switch providers to hide failure. Mention an update only when the CLI actually reports one.
<!-- END PUBLIC CLI RECOVERY CONTRACT -->

## Installation And Non-Interactive Maintenance Rule

- Use `postplus install` for first setup, or `postplus install --current-directory`
  only for an explicitly chosen project scope. The CLI package supplies its
  matching skill content; do not run a separate skills installer or repeat setup
  when switching agent or session. Reuse already-correct installations.
- A `requires_human` or `postplus_skills_content_unverified` result means explain
  the decision and wait for the user. Unverified content has no trusted previous
  fingerprint; do not describe it as user-modified or as proven official content.
  Never create a pseudo-terminal (PTY), pipe confirmation input, or approve on
  the user's behalf to bypass this boundary.
- After explicit approval, use the exact scoped maintenance command reported
  by the CLI with `--yes` to back up and replace the existing content. Keep
  `install` repairs on `install`; do not switch them to a network update. The flag is not
  blanket permission, and a request to perform a marketing task alone does not
  authorize overwriting local edits.

## Supported Script Rule

- Use PostPlus-supported scripts and PostPlus Cloud services as the supported
  execution path.
- Do not replace PostPlus-supported scripts with ad hoc `curl`, `fetch`,
  `node -e`, heredoc, or exploratory shell glue.
- If a supported command reports a terminal infrastructure error, report it
  directly. When it instead provides a same-task recovery checkpoint, follow
  the Async Task Rule; do not treat a disconnected wait as a terminal result.

## Parallel Request Rule

- When multiple tool calls, file reads, script requests, hosted submissions,
  or data-collection requests are independent, prepare their inputs first and
  dispatch them as a bounded parallel batch instead of running them one by one.
- Do not serialize independent requests just because they target different
  files, accounts, URLs, keywords, assets, platforms, or scripts.
- Keep steps serial only when a later request depends on an earlier result, a
  skill explicitly requires a serial queue, approval or quote confirmation is
  still missing, or the skill's own cost/rate-limit boundary requires smaller
  batches.
- For approved side-effecting or hosted work, submit approved
  independent items concurrently within the skill's stated batch or concurrency
  limit. Do not create duplicate requests to mask slow or failing services.

## Async Task Rule

- When a supported command explicitly returns a pending task or a recovery
  checkpoint, preserve it for resuming that task. A handle or a durable file
  alone does not establish whether the task is pending, successful, or failed.
- Do not block the user's conversation by looping on status checks when the
  next useful action does not depend on the finished artifact.
- Tell the user the job is still running, name the durable checkpoint in
  business terms, and continue with independent planning, review, or prep work
  when useful.
- Poll again only when the next step truly needs the finished result or when
  the user explicitly asks to wait for completion.
- If there is no useful parallel work, run one bounded poll pass, report the
  current status, and keep the resume command or checkpoint available. The
  recovery command must be copied from the CLI output, including the capability
  or `--resume-from` checkpoint; do not reconstruct a generic media poll from an
  arbitrary id. Research resumes only from the result file with
  `postplus research run --resume-from <result.json>`. Never extract, paste,
  or rewrite `runHandle`; the CLI reads it byte-for-byte and updates the same
  checkpoint file. A hosted runtime without a shared local filesystem follows
  its own structured polling contract instead of emulating the local command.
- Do not resubmit a paid operation to recover polling. `retryable` alone does
  not prove a new submission is safe. Keep unknown outcomes and costs explicit.

## Work Folder Rule

- Temporary request files, actor-input files, raw datasets, index files, and
  cache-like intermediates belong under the current work folder's `.postplus/`
  directory.
- Keep final user-facing deliverables outside `.postplus/`.
- Treat `.postplus/` as internal implementation state and do not explain its
  management steps to the user unless the user explicitly asks for internals.
- Do not write runtime temp artifacts into installed skill directories.

## Real File Rule

- When a tool or script expects `--input <file.json>` or a comparable file
  argument, provide a real file path.
- If the input must be synthesized first, write it as a real file under
  `.postplus/` instead of passing inline JSON text.

## Hosted Request Shape Rule

- Hosted skills run the converged verb grammar. The agent supplies only the
  skill-specific input; the closed-source CLI runner translates it into the
  hosted request and owns execution metadata.
- Research and media accept product intent directly as semantic flags:
  `postplus research run <route> --<semantic-flags>` and
  `postplus media <verb> <endpoint-key> --<role-or-intent-flags>`. Local media
  paths are valid role values; the CLI handles durable staging internally.
- When the Skill does not already make a flag clear, inspect the exact public
  surface with
  `postplus research schema --route <route> --json`,
  `postplus media schema --endpoint <endpoint-key> --json`, or the target's
  `--help`. Do not create JSON request envelopes for Research or media.
- Publishing intentionally retains an opaque product request:
  `postplus publish <operation> --request <input.json>`. Read
  `postplus publish schema --json` before writing it.
- Do not hand-write runner-managed fields such as ids, tokens, service routing,
  or storage handoffs; the CLI and Web own them.
- Pass shared execution fields as command-supported flags
  (`--quote-confirmation-token` or `--hosted-operation-id`), not inside the
  skill-specific input. Research resume state stays in the `--output` result
  file and is consumed through `--resume-from`; never copy its opaque handle
  into a command or request body.
- If a hosted command prints `Quote confirmation challenge: <path>`, run the
  exact `postplus quote confirm --json --challenge-file <path>` command only
  after user approval, then
  rerun the same hosted command with `--quote-confirmation-token <token>`.

## Conversation Media Rule

- When the user shares images, videos, or other media inside a local AI agent
  conversation, only save or upload the media if the agent can access a real
  local file path, attachment handle, clipboard bytes, or other actual binary
  source exposed by the host runtime.
- If the agent can only see the media as model context and cannot access the
  original bytes, do not recreate, screenshot, summarize, or generate a
  substitute file and present it as the original asset.
- If the requested operation needs the original bytes, explain the unblocker:
  provide a local path or attach through a host mode exposing the file. If the
  user only needs an interpretation of media already visible to the agent,
  inspect it directly within those evidence limits; missing downloadable bytes
  do not prohibit answering a visual question. Do not claim full audio/video
  coverage from still images or metadata.
- Do not send conversation media to PostPlus Cloud through inline base64 in the
  hosted JSON request. Use the supported local file upload path when a real
  file or binary source exists.

## Compile-Step Rule

- For complex research routes, compile the user brief into semantic flags
  before the hosted execution step.
- Inspect or adjust the compiled input when the request is high-cost, ambiguous,
  or unusually broad.

## Local Dependency Bootstrap Rule

- For approved local media dependencies in the current CLI-first release, the
  user's agent must proactively install the missing dependency in the user's
  local environment before running the supported script that needs it.
- Current approved local media dependencies are:
  - `python3`
  - `yt_dlp`
  - `ffmpeg`
  - `ffprobe`
- Skill scripts must call the PostPlus CLI local dependency checks for
  these dependencies. Individual skills must not hard-code OS-specific binary
  names, shell syntax, or install paths.
- The resolver owns platform command selection. It keeps macOS/Linux on the
  canonical `python3` path and uses the Windows Python launcher / Python 3
  command candidates when the host platform is Windows.
- `PostPlus CLI` itself is not the installer for those tools.
- Do not ask a non-technical end user to install those tools manually or to
  interpret tool names such as `ffprobe`.
- Use the smallest direct install path already supported by the host
  environment.
- After installation, rerun a direct verification command before continuing.
- If installation or verification fails, stop immediately and report that
  failure directly instead of inventing fallback glue.

## Cost Discipline

- Default to a bounded first pass before a broader second pass.
- Treat the first pass as evidence gathering for inspection and iteration, not
  as the full-market scrape.
