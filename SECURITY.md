# Security policy

Report vulnerabilities privately through [GitHub security advisories](https://github.com/sparticle9/edge-mailer/security/advisories/new).
Include the affected version, runtime, a minimal reproduction using synthetic
addresses and credentials, and the observed impact. Do not post live tokens,
private keys, message bodies, or recipient lists in issues.

Security fixes target the latest published minor release. Upgrade to the latest
release; older 0.x releases do not have a separate maintenance branch. The API
is still prerelease, and security fixes can tighten previously accepted input.

## Trust boundaries

- Keep SMTP configuration, credentials, DKIM keys, and HTTP sample tokens on
  the server. Callers must authorize recipients and senders before sending.
  Never let an untrusted request choose the SMTP host, port, or credentials.
- Credentials require TLS by default starting in 0.8.0. Explicit
  `tlsPolicy: 'opportunistic'` or `'no-starttls'` allows plaintext; use these
  only for controlled local servers. TLS verification belongs to the runtime
  socket adapter. The library does not offer an option to disable it.
- Message metadata rejects control characters; mailbox arguments must be bare
  addresses. Header values must be single-line strings. This prevents protocol
  injection but does not validate recipient ownership or sanitize HTML content.
- HTTP samples deny protected requests when `SAMPLE_SEND_TOKEN` is absent and
  limit JSON request bodies to 1 MiB. They are server-to-server demonstration
  apps. Add tenant authorization, recipient policy, rate limits and abuse
  controls for a public product. A token holder can submit arbitrary recipients.
- MIME composition buffers the message in memory. Apply attachment and message
  limits before accepting uploads; use links for large assets. The advertised
  SMTP SIZE limit is checked after composition, so it is not a memory limit.
- An SMTP receipt proves server acceptance. It does not prove inbox delivery.
  `delivery_unknown` means a final reply was not obtained after body submission;
  reconcile the attempt before retrying to avoid duplicate mail.
- Observation summaries omit message bodies and addresses. Transcript redaction
  and `SMTPError.toJSON()` are best-effort sanitizers, not a guarantee against
  arbitrary secrets reflected by a server. Prefer summary events and selected
  status fields in production. Receipts intentionally contain recipient data.

## Repository and release safety

The npm and JSR packages contain the library and public integration docs.
Samples, test harnesses, smoke output, local env files, and development tools
are excluded. The local Worker test harness accepts arbitrary SMTP configuration
and must never be deployed publicly.

Publish through the GitHub release workflow after the release checks pass.
The workflow uses registry trusted publishing, checks matching versions/tags,
tests both runtime entrypoints, and validates package contents. Production has
no third-party runtime dependencies; development tooling is audited separately.

A clean scan is evidence about the scanned revision, not a security warranty.
Provider authorization, OAuth token refresh, DNS sender authentication,
recipient consent, delivery reconciliation, and application abuse prevention
remain the integrating application's responsibility.
