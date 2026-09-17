# DealTough Private-Beta Release Checklist

Complete this checklist before inviting testers. This document is an operational checklist, not evidence that a control has been completed.

## Product readiness

- [ ] The target build is identified by commit or release reference.
- [ ] Core analysis flow has been exercised with representative inputs.
- [ ] Request validation behavior matches `deal-input.schema.json`.
- [ ] Example workflow runs in the intended environment.
- [ ] Known limitations are reviewed and included in tester communication.

## Security and privacy

- [ ] No credentials, tokens, `.env` files, or production secrets are included in documentation, examples, logs, or the pull request.
- [ ] Access is limited to explicitly invited testers.
- [ ] Testers are instructed not to submit payment data or sensitive personal information.
- [ ] Error reports and feedback are reviewed for redaction before sharing.

## Tester operations

- [ ] Testers receive the onboarding document and feedback template.
- [ ] An owner is assigned for intake, triage, and tester support.
- [ ] A channel exists for reporting blockers and unexpected behavior.
- [ ] The pause/rollback decision-maker is identified.

## Launch decision

- [ ] Open blockers are reviewed and accepted or resolved.
- [ ] The invite cohort size and duration are set.
- [ ] Success criteria and stop conditions are documented.
- [ ] The beta owner approves sending invitations.
