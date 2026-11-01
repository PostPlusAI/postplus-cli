---
name: postplus-workspace
description: Establish reusable brand facts from an official website, use the shared PostPlus brand and file library, and maintain optional local project context. Keep drafts, adopted facts, and research separate.
metadata:
  postplus:
    familyId: workspace-publishing
    familyName: Workspace, Publishing, and Meta
---

# PostPlus Workspace

Start with an official website, an existing PostPlus brand, saved files, or an
explicitly requested project folder. Reuse confirmed facts across Web, CLI and
MCP. A local folder is optional and never required for independent production.
The agent owns context selection; the current CLI/server own schemas, revisions,
permissions, costing, execution and recovery. Specialist skills own domain judgment.

## Core Contract

1. Read the selected cloud brand/version or relevant local context before acting.
2. Separate confirmed facts, approved claims, research, hypotheses and unknowns.
3. Never invent product facts, prices, offers, identities, files or approvals.
4. Ask when missing/conflicting information changes truth, intent or execution.
5. Make reversible low-risk choices within the user's scope without extra gates.
6. Discover current capabilities through the catalog and command help.
7. Reuse task/standing spending authorization; confirm changes to approved truth,
   publication, live advertising budgets and other unapproved external actions.
8. Preserve original request identity on retries; retain actual results and cost.

## Route

| Request | Route |
| --- | --- |
| Establish a brand from a website | Collect a cloud brand draft |
| Use a brand or saved files | Read the shared personal library |
| Create a project folder | Initialize local workspace |
| Start a campaign or continue a project | Read stage context, then route |
| Research, strategy, testing or production | Read relevant facts and specialist skill |
| Analyze performance | Record observations, conclusions and next hypothesis |

## Collect A Cloud Brand Draft

Cloud brands own editable drafts and immutable adopted versions. Web, CLI and
MCP use the same files, IDs, revisions and facts. Cloud library work requires no
local folder or Python setup check. Read `postplus library --help` when needed.

1. Search `postplus library brands --json` before creating a replacement. Resolve
   ambiguous brands with the user; read the chosen draft and current version.
2. With the user's official website, run
   `postplus library brand-website --url <official-https-url> --json`.
   This returns `preview.content`, sources/times, missing fields and explicit
   page/image failures. It may save verified website images to the library;
   it does not save or adopt brand facts.
3. Review the sourced proposal with the user. Leave unknowns empty. Website
   statements are not approved advertising claims. Further source reading may
   establish additional facts; retain the exact source/time and label inferences.
4. Save reviewed content with `brand-save`, its ID and expected revision.
   Initial save uses one new UUID and revision 0. Retry the same ID, revision and
   content after uncertain outcomes. Compare before replacing existing edits;
   rereading a website never silently changes the adopted version.
5. Adopt only on explicit intent with `brand-adopt`, the saved draft revision
   and one request UUID retained across retries. Read the actual adopted result.
6. Use `brand-use` to select relevant facts, voice or visual rules from an adopted
   version. Retain its exact identity with the brief. Choose real file inputs and
   their roles separately; do not automatically add logos, slogans or generation.

MCP uses the matching `library_*` tools, including
`library_preview_brand_website`, `library_save_brand`, `library_adopt_brand` and
`library_resolve_brand`, with the same review and recovery semantics.

## Read The Shared Personal Library

Search files with `library assets`; reuse the original permanent
`postplus-media://` reference instead of reuploading. Signed preview URLs expire.
Archive/restore changes organization only. Permanent deletion needs explicit
intent; unfinished deletion stays discoverable in archived assets and resumes
that same deletion. Never delete originals as routine cleanup or rerun a paid
operation because catalogue registration failed. Recover completed Web tasks with
`postplus library recover-task <original-task-id>`; hosted generation recovery
continues its original operation ID through the media command.

Local `brand.md` / `product.md` may be explicitly imported to a draft or exported
from a chosen version. No implicit bidirectional overwrites. Campaign plans,
full research reports and hypotheses remain project context, not adopted facts.

## Initialize An Explicitly Requested Local Workspace

1. Resolve the target and inspect existing files. Do not scatter files elsewhere.
2. Run `postplus doctor --skill postplus-workspace --json`. If Python is missing,
   follow its concrete action; stop that local initialization if none is given.
3. Resolve this installed skill root and run:

```text
<python-3-command> <skill-directory>/scripts/workspace.py init \
  --target <folder> --project "<project name>" \
  --output <folder>/.postplus/workspace-init.json
```

Optional `--brand`, `--product`, `--market`, `--platform` use only sourced/user
values. The entrypoint creates missing files and rejects unsafe targets.
Fill confirmed facts, preserve `UNKNOWN`, then run the onboarding check.

## Continue A Local Project Or Campaign

Read the nearest `project.yaml`, applicable `AGENTS.md` and only stage-relevant
files from [context-schema.md](references/context-schema.md). Route to the
specialist skill and resume recorded work rather than recreating it.
To initialize a requested campaign, use the same entrypoint's `new-campaign`
with `--target`, `--name`, optional `--slug` and an explicit `--output` report.
Fill objective, market, platform, offer, CTA, KPI, constraints and approval state;
set `current_campaign` only for the intended campaign.

## Stage Checks And Durable Results

Follow [stage-gates.md](references/stage-gates.md). Run the workspace entrypoint's
`check --target <folder> --stage <stage> --output <report.json>` before high-impact
local execution. Stages: onboarding, research, strategy, test, production, launch,
learn. `BLOCKED` stops the affected stage; local `READY` never replaces current
prices, balance, provider validation, authorization or live state.
For campaign stages, pass `--campaign <intended-campaign-slug>` and confirm the
returned campaign matches the intended one before using its readiness result.
Use [uncertainty-policy.md](references/uncertainty-policy.md) for material gaps.
Save confirmed results, actual cost, chosen brand/version and next actions in
the relevant cloud record or requested workspace. Explain blockers and the next
useful action concisely. Local templates are in `assets/project-template/`.
