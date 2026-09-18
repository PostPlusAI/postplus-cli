---
name: postplus-shared
description: Start using PostPlus, discover what it can do, or choose a first task (带我开始使用 PostPlus、PostPlus 能做什么). Shared rules, routing preferences, execution boundaries, and workflow references for released PostPlus skills. Use this before any PostPlus skill that mentions shared public skill rules, research preferences, product-selection preferences, source-of-truth files, TikTok music workflow, ads workflow, or user guidance.
metadata:
  postplus:
    familyId: shared-rules
    familyName: Shared Rules
---

# PostPlus Shared

Use this skill when the user asks to start using PostPlus or explore its capabilities, as well as when another PostPlus skill asks for shared rules or shared workflow preferences.

## Getting Started

For “带我开始使用 PostPlus”, “PostPlus 能做什么”, or equivalent requests in any language, read [`postplus-getting-started.md`](references/postplus-getting-started.md). It owns the capability introduction, progressive disclosure, and first-task handoff. Do not run onboarding merely because this shared skill was loaded by another skill. A concrete task should go directly to its existing workflow; do not force a capability tour. Installation does not automatically load this entrypoint into an existing agent session.

This skill is the single source of truth for principle-level PostPlus skill documents. It is instruction-only: do not run provider runtimes, mutate public metadata or release metadata, or invent alternate execution paths from this shared-rule handoff.

## References

- [`postplus-getting-started.md`](references/postplus-getting-started.md) — first-use guidance and the authoritative capability introduction.

- [`shared-public-skill-rules.md`](references/shared-public-skill-rules.md)
- [`shared-research-preferences.md`](references/shared-research-preferences.md)
- [`research-quality-recovery.md`](references/research-quality-recovery.md)
- [`shared-product-selection-preferences.md`](references/shared-product-selection-preferences.md)
- [`shared-source-of-truth-files.md`](references/shared-source-of-truth-files.md)
- [`shared-tiktok-music-workflow.md`](references/shared-tiktok-music-workflow.md)
- [`shared-ads-workflow.md`](references/shared-ads-workflow.md)
- [`shared-user-guidance.md`](references/shared-user-guidance.md)
- [`dataset-item-schemas.md`](references/dataset-item-schemas.md) — result-record field tables for every released Research route.

## Default Workflow

1. Read the reference named by the downstream skill.
2. Apply the shared rule before reading platform- or production-specific details.
3. If a downstream skill and this shared rule conflict, fail fast and surface the conflict instead of inventing a fallback.
4. Keep executable work in the downstream skill or PostPlus CLI boundary; this shared skill only owns the principle-level rule.
