# Manual setup checklist

These are the steps only the repository owner can do. Run them in order. Everything else is in the repository already.

The live instance is [`AieatAssam/nightly-demoparty`](https://github.com/AieatAssam/nightly-demoparty), and its gallery is served at <https://aieatassam.github.io/nightly-demoparty/>. On a fork, replace `AieatAssam/nightly-demoparty` with your own account and repository name.

## Status

> **Already provisioned on `AieatAssam/nightly-demoparty`**
>
> - Step 1: public repository created and `main` pushed.
> - Step 2: `CLAUDE_CODE_OAUTH_TOKEN` repository secret configured.
> - Step 3: GitHub Pages enabled with the GitHub Actions source.
> - Step 4: Actions read and write workflow permissions enabled, and a `main` branch protection ruleset configured.
>
> **Remaining steps to go live**
>
> - Step 5: run the first manual `workflow_dispatch` dry run with `dry_run: true`, plus the optional 10-run shakeout.
> - Step 6: uncomment the `schedule:` cron triggers in `.github/workflows/{nightly,weekly,monthly}.yml` and push.

The full steps below stay intact, so any fork can reproduce the whole setup from scratch.

## 1. Create the GitHub repository and push `main`

The local repository has no remote yet. Its commits are ready on `main`.

Create an empty repository on GitHub (no README, no .gitignore, no license, so the first push does not conflict). Then, in the local checkout:

```sh
git remote add origin git@github.com:AieatAssam/nightly-demoparty.git
git push -u origin main
```

Use the HTTPS URL instead if you do not use SSH keys with GitHub.

## 2. Generate and add `CLAUDE_CODE_OAUTH_TOKEN`

1. Run this locally and follow the prompts:

   ```sh
   claude setup-token
   ```

2. In GitHub, open **Settings -> Secrets and variables -> Actions -> New repository secret**.
3. Name it `CLAUDE_CODE_OAUTH_TOKEN` and paste the token from step 1.

Or set it from the command line with the GitHub CLI, which prompts for the value so it never lands in your shell history:

```sh
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AieatAssam/nightly-demoparty
```

Notes:

- The token draws on the personal Claude subscription that created it. Nightly runs share its rate limits with your interactive use.
- This is the **only** secret the workflows use. Do not add others.

## 3. Enable GitHub Pages with GitHub Actions

1. In GitHub, open **Settings -> Pages -> Build and deployment -> Source** and select **GitHub Actions**.
2. Open **Settings -> Environments -> github-pages**. `nightly.yml` and `monthly.yml` deploy through this `github-pages` environment. Check that deployments from `main` are allowed. If the environment restricts deployment branches, add `main`.

## 4. Verify Actions workflow permissions

1. In GitHub, open **Settings -> Actions -> General**.
2. Under **Actions permissions**, make sure Actions are enabled for this repository.
3. Under **Workflow permissions**, select **Read and write permissions**.

Why: every workflow sets `permissions: contents: read` at the top level. Jobs that need to write declare more, and GitHub caps that at the repository setting. The write-capable jobs are:

- `publish` in `nightly.yml`: `contents: write`, `pages: write`, `id-token: write`.
- `showcase` in `monthly.yml`: `contents: write`, `pages: write`, `id-token: write`.
- `apply` in `weekly.yml`: `contents: write`.

If this setting stays on read-only, the commit and push steps fail.

## 5. Run the first manual dry run

1. Open **Actions -> Nightly Demoparty -> Run workflow**.
2. Set `dry_run` to `true`. The optional inputs `force_domain`, `force_compo`, and `force_mood_preset` may stay blank, or set them to exercise a specific path.
3. Wait for every job to pass.
4. Download the `night-audit` artifact. Check the summary JSON and the per-stage files.
5. Confirm that nothing was committed or deployed. With `dry_run: true` the publish job skips the commit-and-push step. Check the commit history on `main` and the Pages site.

Before you leave the system unattended, run the 10-run `workflow_dispatch` shakeout from `SPEC.md` Milestone 6. Start 10 consecutive dry runs. The acceptance bar is at least 7 of 10 nights clearing the publish bar within 3 attempts, no two nights sharing a technique family, and average cost within budget.

## 6. Enable the cron schedules

Each workflow has its `schedule:` block commented out until the dry runs pass. Uncomment it in each file:

- `.github/workflows/nightly.yml`: `cron: '17 2 * * *'` (daily, 02:17 UTC). Change the hour if it overlaps your interactive Claude use.
- `.github/workflows/weekly.yml`: `cron: '30 3 * * 0'` (Sunday, 03:30 UTC, retrospective).
- `.github/workflows/monthly.yml`: `cron: '0 4 1 * *'` (1st of the month, 04:00 UTC, showcase).

Then commit and push to `main`:

```sh
git add .github/workflows/nightly.yml .github/workflows/weekly.yml .github/workflows/monthly.yml
git commit -m "Enable nightly, weekly and monthly schedules"
git push origin main
```

The first weekly retrospective is only meaningful after about 7 nights of verdicts in the ledger. Until then it has little to review.
