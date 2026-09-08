# Deploy the SMTP samples with GitHub Actions

One explicit `.env.*` file per runtime, one GitHub secret upload, then a manual
workflow run. No settings-page data entry or private branch is needed. This
workflow deploys the existing [Cloudflare](../cloudflare-worker-smtp) or
[Deno](../deno-smtp) SMTP sample. The contact-form/D1 outbox starters retain their
own deployment guides.

## 1. Fill a local deployment file

Use Node 24, pnpm, and an authenticated GitHub CLI account with permission to set
secrets and run workflows in **your own repository**. The deployment workflows
must exist on that repository's default branch. A fork or independently copied
repository works; you must enable Actions if your repository has them disabled.

```sh
pnpm install --frozen-lockfile
cp sample/deploy/cloudflare.env.example .env.deploy.cloudflare
cp sample/deploy/deno.env.example .env.deploy.deno
```

Edit the file for the runtime you want. Both `.env.deploy.*` files are already
ignored. Supply scoped provider credentials, your SMTP settings, a single test
recipient you control, and a `SAMPLE_SEND_TOKEN` of at least 32 characters.
`openssl rand -hex 32` generates an appropriate sample token. Do not use the
SMTP password as that token. The deployed SMTP endpoints allow token holders to
choose message recipients; keep this token on trusted servers.

Cloudflare needs a token for the selected account with Workers Scripts Write and
Account Settings Read. The workflow deploys to `workers.dev`, without zone/DNS
changes. Deno needs a Deploy access token and the organization/app slugs; a missing
app is created automatically. Reuse a dedicated sample app, not another service.
An existing Deno app must use the dynamic runtime and entrypoint
`sample/deno-smtp/main.ts` from its root. Creation first deploys an unconfigured
sample that rejects sends; runtime settings and the production deployment follow.

The reader uses Node's dotenv parser: **no shell execution, variable expansion,
or implicit loading of the root `.env`**. Quote values containing `#` or spaces.
For multiline DKIM keys, use a quoted multiline value or the sample's literal
`\n` representation. `SMTP_USER`, `TEST_RECIPIENT_EMAIL`, and `DENO_ACCESS_TOKEN`
are accepted aliases for existing setups.

## 2. Validate and upload

```sh
# Checks the file without contacting GitHub or a provider. Prints no values.
pnpm deploy:setup cloudflare --env-file .env.deploy.cloudflare --repo OWNER/REPO

# Uploads only the allowlisted settings as one encrypted GitHub Actions secret.
pnpm deploy:setup cloudflare --env-file .env.deploy.cloudflare --repo OWNER/REPO --apply

# Same workflow for Deno:
pnpm deploy:setup deno --env-file .env.deploy.deno --repo OWNER/REPO --apply
```

Use `--gh ghx` if your workstation routes GitHub accounts with `ghx`. Every upload
specifies the repository explicitly; the helper never switches your CLI account.
The normal `gh` command is the default for community users.

Cloudflare stores `EDGE_MAILER_CLOUDFLARE_DEPLOY`; Deno stores
`EDGE_MAILER_DENO_DEPLOY`. Each is an allowlisted JSON bundle, not the original
file. Unrelated entries (including GitHub tokens and other provider keys) are
excluded. Values pass through stdin to `gh secret set`, not command arguments.
Running setup again replaces that target's bundle. It does **not** deploy.

## 3. Run the deployment

```sh
gh workflow run deploy-cloudflare.yml --repo OWNER/REPO
gh workflow run deploy-deno.yml --repo OWNER/REPO
```

Or select **Deploy cloudflare sample** / **Deploy deno sample** in Actions and
choose **Run workflow**. Use `ghx` in place of `gh` on workstations that require
account routing. Deployments are restricted to the default branch; other branch
runs are skipped. Deployments for the same target run serially.

Each workflow deploys, discovers the application URL, checks configured/protected
health, and confirms unauthenticated POST returns 401. It prints a sanitized
verdict and the deployed URL. By default it sends **zero emails**.

To send exactly one SMTP test message to your configured recipient:

```sh
gh workflow run deploy-cloudflare.yml --repo OWNER/REPO -f send_test_email=true
# Or deploy-deno.yml for Deno.
```

The checkbox is also available in the Actions UI. Test sends are never retried
automatically. If the result is unconfirmed, inspect provider logs before rerunning
a workflow with sending enabled. SMTP acceptance is reported separately; mailbox
receipt is not checked. Manually confirm the test message in your destination
mailbox when you need delivery evidence.

## Secret delivery and recovery

| Location                                      | Contents and ownership                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Your secret manager / local explicit env file | Source values, owned and recoverable by the deployer                                               |
| GitHub Actions repository secret              | One target-specific deployment bundle; a delivery copy                                             |
| Runner temporary directory                    | Runtime-only file, private permissions, removed on success/failure; outside the Deno source upload |
| Cloudflare Worker / Deno app                  | SMTP and sample runtime settings; provider deployment credentials excluded                         |
| Public Git repository/package                 | Generic workflows, helper code and blank/example templates only                                    |

The exact allowlist is in [`config.mjs`](../../scripts/deploy/config.mjs).
TLS is required on ports 465, 587 or 2525. The active password/OAuth mechanism is
always explicit. GitHub secrets are not a recovery source: keep the source values
in your normal credential system and repeat setup after moving repositories.
No particular secret manager is required by these scripts.

Rotation is two steps: update/upload the local bundle, then run deployment.
Provider updates are additive: omitted runtime settings are **not deleted**.
Explicitly remove retired credentials/settings in the provider when appropriate,
particularly after changing authentication mechanisms. The sample's explicit
auth type prevents an old password from silently taking precedence over OAuth.

Workflows, helper code and dependencies with access to credentials must be
trusted. Keep deployment secrets out of PR jobs, review default-branch changes,
and configure additional GitHub protections if your collaboration model needs
them. Raw provider CLI output is deliberately withheld because it may contain
runtime settings; errors identify the failed stage. Use the provider dashboard
or a private local session for detailed troubleshooting. The deployed URL is
printed in public Actions logs.

Deno uploads only tracked TypeScript under `src/`, the Deno HTTP sample,
`sample/http.ts`, and a generated `deno.json`. The helper pins the official Deploy
CLI to `@deno/deploy@0.0.9904`; this avoids the help/subcommand parsing failure
observed with the current `deno deploy` launcher. It is Deno Deploy, not Deploy
Classic/deployctl. First use downloads the pinned CLI and its dependencies.

## Verification

`pnpm run test:deploy` tests validation, allowlisting, stdin upload, temporary-file
cleanup, Deno create/reuse/error behavior, source packaging, dotenv compatibility,
and opt-in sending. Provider/GitHub operations use controlled test doubles;
there are no live credential or deployment calls in these tests. They are also
part of the regular release checks. The workflows need live credentials to prove
actual provider deployment; local tests alone do not establish that verdict.

References: [GitHub secret CLI](https://cli.github.com/manual/gh_secret_set),
[Wrangler deployment](https://developers.cloudflare.com/workers/wrangler/commands/),
[Deno Deploy CLI](https://docs.deno.com/runtime/reference/cli/deploy/).
