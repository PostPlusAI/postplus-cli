---
name: postplus-shared
description: Start using PostPlus, discover what it can do, or choose a first task (带我开始使用 PostPlus、PostPlus 能做什么). Read the specific shared reference requested by another PostPlus skill; do not load every reference for every task.
metadata:
  postplus:
    familyId: shared-rules
    familyName: Shared Rules
---

# PostPlus Shared

For getting-started and capability questions, read
[`postplus-getting-started.md`](references/postplus-getting-started.md).
Use the user's language. A concrete task goes directly to its matching skill;
loading this shared entrypoint must not restart onboarding.

## Read Only What the Task Needs

| When | Reference |
| --- | --- |
| Introduce PostPlus or explain work to the user | [Getting started and user guidance](references/postplus-getting-started.md) |
| Execute a supported command, handle failure or continue a pending task | [Execution rules](references/shared-public-skill-rules.md) |
| Research completed but the evidence is empty, irrelevant or too weak | [Research quality](references/research-quality-recovery.md) |
| Interpret fields in a research result | [Result field tables](references/dataset-item-schemas.md) |
| Reuse established brand/product facts across repeated creative work | [Project facts](references/shared-source-of-truth-files.md) |

These are references, not a sequence of mandatory checks. Use the executing
skill's inputs and supported workflow. Do not run provider runtimes or mutate public metadata or release metadata from this shared entrypoint. It grants no payment, publishing or overwrite approval.
