# Open-source readiness review — 0.8.0

Reviewed on 2026-09-08, starting from `f2672363d5bd16aaba8f2bedf476dc1693e397d9`.
The repository was already public and npm's latest release was 0.7.5. This
review prepares the previously unreleased local work and the fixes below as
0.8.0. It does not claim 1.0 stability or fresh provider delivery qualification.

## Product assessment

The useful promise is: **send transactional email through your existing SMTP
infrastructure from Workers or Deno, with no third-party runtime dependencies.**
MIME, attachments, calendar invites, provider probing, and structured outcomes
support that promise. More protocol switches are less valuable to adoption than
a complete first workflow, understandable failure handling, and dated evidence.

The README now starts with a send example and links to five user stories in
[USE-CASES.md](USE-CASES.md). Contribution guidance, bug/feature templates,
private security reporting, automatic CI, and package checks make the project
easier to evaluate and contribute to.

## Findings addressed

Severity describes the original behavior and its prerequisites, before this
release's fixes.

| Priority | Finding and impact                                                                                                                                    | Resolution                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| High     | Message metadata reached MIME headers and SMTP paths without rejecting control characters; untrusted form or API fields could inject headers/commands | Validate metadata, quoted parameters, mailbox paths, and runtime envelope options; normalize newline forms before DATA transparency |
| High     | Worker and Deno HTTP samples authorized requests when no sample token was configured; a deployed sample could become an open mail relay               | Missing tokens deny access; shared authorization helper; JSON body cap and malformed-body rejection                                 |
| High     | Authenticated sessions defaulted to opportunistic TLS and could send credentials when STARTTLS was absent                                             | Credentials default to required TLS; invalid policies fail; explicit plaintext remains an opt-in                                    |
| High     | Buffered plaintext replies could survive a STARTTLS upgrade                                                                                           | Clear the response buffer after upgrading                                                                                           |
| Medium   | Credentials could be silently ignored when AUTH was not advertised                                                                                    | Reject the connection instead of returning an apparently authenticated client                                                       |
| Medium   | Lost final DATA replies were classified as retryable timeouts                                                                                         | Introduce `delivery_unknown` with an unknown retry hint and reconciliation guidance                                                 |
| Medium   | Pipelined DATA was sent before all recipient results were known; a rejected recipient could leave RSET inside DATA mode                               | Pipeline the envelope, then enter DATA only after all recipients succeed                                                            |
| Medium   | Arbitrarily long server replies could accumulate in memory                                                                                            | Bound response buffering and close on overflow                                                                                      |
| Medium   | Server SIZE was reported but not enforced; SIZE included dot-stuffing; an empty reverse path fell back to the visible sender                          | Check actual MIME size, exclude transparency bytes, preserve null reverse paths                                                     |
| Medium   | Unicode calendar attachments used Latin-1 `btoa` directly, and line folding counted characters rather than bytes                                      | Encode UTF-8 before base64, fold by octets, escape/validate metadata and mark date-only values                                      |
| Medium   | Reused input headers could acquire generated headers and reuse Message-ID across messages                                                             | Copy caller metadata before composition                                                                                             |
| Medium   | The Worker smoke helper placed SMTP values in process arguments                                                                                       | Use a private, temporary environment-specific vars file and remove it afterward                                                     |
| Medium   | Development dependency audit reported 45 findings: 25 high, 16 moderate, 4 low                                                                        | Update tooling and apply scoped temporary transitive overrides; final audit reports zero                                            |
| Medium   | CI ran only manually and did not exercise the complete release gate                                                                                   | Run on PRs and main pushes; test both runtimes, check package contents, audit dependencies, pin action revisions                    |
| Low      | Example env settings enabled conflicting password/XOAUTH2 choices and used a display-name string where a bare mailbox was expected                    | Keep optional auth commented out and use a bare mailbox                                                                             |
| Low      | Invalid pool limits could become NaN and prevent acquisition                                                                                          | Validate pool numeric settings; validate SMTP port, timeouts, and TLS policy                                                        |

Existing local runtime values, smoke artifacts, and reference material were not
included in the release. Live provider sends and deployments were not performed
during this review.

## Validation evidence

- Unit suite: 230 passing tests, including injection, downgrade, sample-auth,
  body-limit, recipient rejection, cancellation, and UTF-8 calendar regressions.
- Real local SMTP suite: 11 passing tests for shared protocol behavior.
- Deno checks passed; 9 Deno connector and local SMTP tests passed.
- ESM/CJS bundles and declarations build successfully.
- npm pack contains 25 intended files. An extracted tarball's Deno entrypoint
  imports and composes MIME and a Unicode calendar attachment successfully.
- Local Wrangler sample health and authenticated MIME preview pass using an
  environment-specific private vars file, without an SMTP send.
- JSR publish dry-run passes for the source entrypoints and intended docs.
- Gitleaks 8.30.1 scanned 39 historical commits across all local refs and the
  candidate public-file snapshot, with no findings. Ignored credential stores
  were excluded; this is not evidence about the safety of their contents.
- pnpm audit reports zero known vulnerabilities across the final development
  dependency graph. The package has no production dependencies. Database
  results are time-dependent; CI repeats the audit.
- GitHub private vulnerability reporting is enabled. Main had no branch
  protection rule at review time; automatic checks do not themselves prevent a
  maintainer from bypassing them.

This is a source review, automated scan, and local acceptance pass, not an
independent penetration test or a proof that all defects have been found.

## Remaining work, ordered by user value and operational risk

| Priority                                   | User story / remaining risk                                              | Concrete acceptance criterion                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next                                       | A new user ships a safe contact form without becoming an open relay      | Runnable starter with fixed recipient/sender, validated Reply-To, rate limit/abuse checks, and documented setup from a clean clone                                                                                                                   |
| Next                                       | A queued notification survives retries without silently duplicating mail | Durable outbox example, stable app id, acceptance persistence, bounded retries, dead-letter path, and an induced lost-DATA-reply scenario                                                                                                            |
| Next                                       | A team trusts the provider/runtime support matrix                        | Dated successful acceptance results for at least two providers on both runtimes, including TLS mode, auth mechanism, package version, and limitations; separate mailbox evidence from SMTP acceptance                                                |
| Before heavy concurrency                   | Cancellation and resource deadlines cover every waiting state            | Add cancellable pool acquisition and bounded queue size; test stalled socket writes/TLS handshakes, slow token callbacks, late connects, and cancellation at each stage. Existing connect/read timers do not establish coverage of all these states  |
| Before large payloads                      | A report sender can choose safe attachment limits                        | Measure peak memory and CPU for representative payload sizes in both runtimes; enforce application limits before composing MIME. Composition currently buffers the entire message                                                                    |
| Before strong deliverability claims        | DKIM and invites work with independent consumers                         | Verify signatures with an independent verifier and representative header/body fixtures; test REQUEST/update/CANCEL rendering in target mail clients. Existing DKIM tests establish signing and server acceptance, not mailbox authentication results |
| Before broader internationalization claims | Long multilingual headers and calendar edge cases stay interoperable     | Add RFC 2047 encoded-word/line-length fixtures, international filename parameters, invalid/mixed date tests, and calendar timezone/recurrence decisions                                                                                              |
| Maintenance                                | Contributors cannot accidentally bypass release verification             | Consider required main-branch checks, automated secret scanning of future contributions, and removing transitive overrides when upstream tools absorb the fixes                                                                                      |

Do not expand the core into OAuth credential custody, inbound mail, campaign
management, or provider HTTP SDK aggregation to fill these gaps. Those are
application/service concerns, and would weaken the current small-library scope.

## Standards consulted

- [SMTP command framing and DATA transparency, RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html)
- [TLS for email submission, RFC 8314](https://www.rfc-editor.org/rfc/rfc8314.html)
- [iCalendar content lines and UTF-8 folding, RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)
- [Cloudflare socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
