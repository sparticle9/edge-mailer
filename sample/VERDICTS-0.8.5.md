# 0.8.5 starter verification verdicts

Validated on 2026-09-08 Asia/Shanghai (2026-09-07 UTC), with Node 24,
Deno 2, pnpm 11.1.2, Wrangler 4.129.0 and the local Workers/D1 runtime.

**Verdict: PASS for the bounded starter scenarios below.** These are runnable
application examples, not a deployed mail service or an exactly-once delivery
system. No real SMTP credentials, external recipients, or production Cloudflare
resources were used for these checks.

## Contact form

| Scenario                                                                | Verdict | Evidence                                                             |
| ----------------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| Browser form/assets, CSP and default SMTP adapter wiring                | PASS    | Local Wrangler HTTP startup plus Worker tests                        |
| Fixed sender/recipient, visitor Reply-To, text-only user content        | PASS    | Attempted client routing overrides ignored; SMTP arguments inspected |
| Header injection, honeypot, empty/oversized input, wrong/missing origin | PASS    | Rejected before SMTP                                                 |
| Missing configuration, rejected/unavailable Turnstile                   | PASS    | Fails closed; no SMTP call                                           |
| Turnstile action and hostname enforcement                               | PASS    | Negative Siteverify response fixtures                                |
| Concurrent per-IP limit                                                 | PASS    | Nine concurrent submissions: five sends, four 429s                   |
| Global limit, hashed IP storage and counter cleanup                     | PASS    | Real local D1 SQL assertions                                         |
| Ambiguous SMTP result                                                   | PASS    | 202 unknown with reference; browser suppresses resubmission          |

## Durable outbox

| Scenario                                            | Verdict | Evidence                                                                                                |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| Enqueue/status authorization and request validation | PASS    | Missing/bad token and invalid payloads cannot create work                                               |
| Durable enqueue and idempotency conflict handling   | PASS    | Eight simultaneous equal keys create one row; changed payload returns 409                               |
| Concurrent consumption                              | PASS    | Two consumers produce one SMTP call and one attempt                                                     |
| Acceptance and safe status output                   | PASS    | Receipt metadata persisted; status omits recipient/body/raw SMTP text                                   |
| Transient retry                                     | PASS    | Due-time gate, backoff, subsequent success, stable Message-ID                                           |
| Permanent error and retry exhaustion                | PASS    | Immediate dead-letter or maximum three attempts                                                         |
| Lost final DATA reply                               | PASS    | SMTP stream fixture integrated with D1 preserves unknown; later drain does not resend                   |
| Real socket lost acknowledgement                    | PASS    | Loopback TCP server receives complete DATA then disconnects; engine returns delivery_unknown            |
| Process crash/expired lease                         | PASS    | Sending becomes unknown, never reclaimed for sending                                                    |
| Database failure after SMTP acceptance              | PASS    | Injected SQLite trigger aborts completion transaction; recovery holds unknown without another SMTP call |
| Unclassified exception                              | PASS    | Held for reconciliation                                                                                 |

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm run test:starters    # 26 scenario tests, using real local D1 and controlled SMTP/challenge outcomes
pnpm run test:smtp-core  # 12 real local SMTP/TCP tests
pnpm run check:starters  # both starter TypeScript projects and Wrangler bundles
pnpm run release:dry-run # full 256 Worker/unit + 12 SMTP + 9 Deno tests, build, package checks
pnpm audit --audit-level=high
```

The complete suite totals **277 passing tests**. The package allowlist check
contains **25 intended npm files**; samples/tests/local secrets stay out of npm
and JSR. Dependency audit reports no known vulnerabilities. Publication uses the
repository's GitHub release workflow, which repeats the full gate. The JSR dry-run
requires committed source; running it on an edited working tree intentionally
fails that cleanliness check.

Both migrations were applied successfully to empty local D1 databases using the
README commands. Both Workers were started with `wrangler dev --local`; contact
HTML/JS/CSS returned 200, an unconfigured form POST returned 503, and the outbox
rejected unauthenticated access with 401. The compatibility date was corrected
to the current UTC date after startup caught an unsupported future date.

## Limits of this verdict

- Turnstile network responses are controlled fixtures; a real widget and SMTP
  provider must be configured and verified by the deployer. Full interactive
  challenge completion and live external mailbox delivery were not tested.
- D1 durability/atomicity is exercised through the local Workers binding, not
  production-region failover or load testing.
- The outbox is intentionally low-throughput and single-caller. Business commit
  integration, tenant isolation, quotas, alerting, retention and operator evidence
  remain application responsibilities, with boundaries described in its guide.
- Ambiguous SMTP outcomes require human/provider reconciliation. Stable IDs,
  attempt records and leases cannot establish exactly-once SMTP delivery.
