# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report security issues by email to **security@postplus.io**.

We will acknowledge receipt within 48 hours and aim to provide an initial
assessment within 7 days.

GitHub Private Vulnerability Reporting is also enabled for this repository.
You can submit a report at:
https://github.com/PostPlusAI/postplus-cli/security/advisories/new

## Scope

The PostPlus CLI:

- stores session tokens in a local config file (owner-read/write only, 0600)
- opens a short-lived local HTTP listener on 127.0.0.1 during the browser
  sign-in handoff (closed immediately after sign-in completes)
- communicates with PostPlus Cloud over HTTPS only

Please include in your report:

- a description of the vulnerability and its impact
- steps to reproduce or a proof-of-concept
- affected versions if known

We follow responsible disclosure and ask that you allow a reasonable time to
fix the issue before publishing details publicly.
