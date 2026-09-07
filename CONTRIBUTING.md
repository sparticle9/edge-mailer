# Contributing

Edge Mailer is a small SMTP submission library for Cloudflare Workers and Deno.
Useful contributions include reproducible provider compatibility reports,
protocol regression tests, accessible examples, and improvements to the first
send experience. Discuss new runtime adapters or major API changes in an issue
before building them.

## Get started

Use Node.js 24, the pnpm version in `package.json`, and Deno 2:

```sh
pnpm install --frozen-lockfile
pnpm run release:dry-run
```

The automated checks use synthetic credentials and local SMTP servers. No
external mail account or deployment credential is needed. See
[DEVELOPMENT.md](DEVELOPMENT.md) for optional live tests; these send real mail
and should only target mailboxes you control.

Keep changes focused, include a regression test for behavior changes, and
update the relevant public docs. Use `sample/` for runnable integrations and
keep runtime-specific imports behind their adapters. Both runtimes must keep
working. For a user-facing change, add a Changeset with `pnpm changeset`.

In a pull request, describe the user-visible problem, the change, and the
checks you ran. Use synthetic `example.com` addresses in code and reports.
Do not commit `.env` files, deployment artifacts, or private reference material.

## Community

Be respectful and constructive. Harassment, discriminatory language, and
sharing someone else's private information are not welcome. Maintainers may
remove inappropriate content or restrict participation to keep collaboration
safe. This is a community project without a support SLA.

Use issues for bugs and proposals. For vulnerabilities, follow
[SECURITY.md](SECURITY.md) and report privately.
