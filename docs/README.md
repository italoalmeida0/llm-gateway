# V2 release preparation

Start with the [V2 release readiness review](v2-release-readiness.md). It records
the confirmed problems, their impact, proposed fixes, and acceptance criteria.
The [review probes](review-probes/README.md) preserve executable reproductions
without adding known failures to the normal test suite.

The reviewed source is `dev` at `7f2c8c0`, compared with V1 at `origin/main`
`e5a4b07`. Findings were checked on 2026-09-25. All seven items were resolved
in the V2 hardening change-set (`59fae80`, `922bf0e`, `fc72343`) — per-item
evidence and the remaining release-process gates live in the review.

| ID | Priority | Work item | Status |
| --- | --- | --- | --- |
| V2-001 | High | Stop the watchdog from cancelling legitimate waits | Resolved |
| V2-002 | High | Give outbound WS events an explicit delivery/recovery policy | Resolved |
| V2-003 | High | Preserve background completion notices under backpressure | Resolved |
| V2-004 | High | Restore pending decisions in reconnect snapshots | Resolved |
| V2-005 | Release blocker | Align manifest validation with the single application artifact | Resolved |
| V2-006 | Medium | Isolate inbound commands across sessions | Resolved |
| V2-007 | Maintenance | Align architecture guidance with the implemented V2 behavior | Resolved |

**Decided scope:** V1 to V2 installation/migration is manual. Automatic V1
upgrades, legacy launcher download aliases, and a bridge release are not release
requirements. Keep the single application binary. This decision does not disable
the V2 updater or remove the need to validate V2 release artifacts.

Statuses link to the fixing commits and the relevant test results in the
review. The original evidence is kept so the reason for each change stays
understandable.
