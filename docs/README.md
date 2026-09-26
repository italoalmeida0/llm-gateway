# V2 release preparation

Start with the [implemented recovery fixes](v2-runner-follow-up.md#implemented-recovery-fixes),
following the verification of `4958354`. The six failing reproductions across
V2R-001, V2R-002, V2R-007, V2R-008, and V2R-010 now pass and have permanent
regression coverage. The section records the exact changes, validation, and
remaining release-validation limits. Earlier sections preserve the review history.

The [original review](v2-release-readiness.md) compared `dev` at `7f2c8c0`
with V1 at `origin/main` `e5a4b07` on 2026-09-25. The subsequent hardening
changes (`59fae80`, `922bf0e`, `fc72343`) addressed those findings, but the
follow-up reopens delivery edge cases and identifies new runner regressions.
The [review probes](review-probes/README.md) preserve executable reproductions
without adding known failures to the normal test suite.

| ID | Priority | Work item | Status |
| --- | --- | --- | --- |
| V2-001 | High | Stop the watchdog from cancelling legitimate waits | Resolved |
| V2-002 | High | Give outbound WS events an explicit delivery/recovery policy | Reopened: V2R-007 |
| V2-003 | High | Preserve background completion notices under backpressure | Retry implemented; durability follow-up V2R-008 |
| V2-004 | High | Restore pending decisions in reconnect snapshots | Decisions restored; stream-content follow-up V2R-007 |
| V2-005 | Release blocker | Align manifest validation with the single application artifact | Resolved |
| V2-006 | Medium | Isolate inbound commands across sessions | Resolved |
| V2-007 | Maintenance | Align architecture guidance with the implemented V2 behavior | Updated; runner contract still needs alignment |

**Decided scope:** V1 to V2 installation/migration is manual. Automatic V1
upgrades, legacy launcher download aliases, and a bridge release are not release
requirements. Keep the single application binary. This decision does not disable
the V2 updater or remove the need to validate V2 release artifacts.

Statuses link to the fixing commits and the relevant test results in the
review. The original evidence is kept so the reason for each change stays
understandable.
