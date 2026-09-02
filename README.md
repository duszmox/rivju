# rivju

rivju is an **Electron desktop app for agentic review of GitLab merge requests**.
It runs headless Claude Code agents on your machine against a local checkout of
an MR and collects structured, verified review findings.

Findings are anchored to exact code snippets and re-anchored as the MR evolves,
so triage survives new pushes. Your triage decisions (valid / invalid + note)
are kept separate from the system's lifecycle state (open / fixed / stale).

## Use cases

- **Review MRs assigned to you** — pick an MR from your review queue, launch an
  agent review, and triage findings inline on the diff with keyboard-driven
  triage (`j`/`k`/`v`/`x`).
- **Re-verify after changes** — run a targeted `verify` pass that only checks
  still-open findings instead of re-reviewing everything.
- **Consistent, repeatable reviews** — enable review skills (built-in, user, or
  project-scoped) to steer what the agent looks for, per project or globally.
- **Multiple GitLab instances** — browse MRs across several self-hosted GitLab
  instances with personal access tokens stored encrypted on disk.
- **Cost and progress visibility** — live run queue with phase, tool-call
  ticker, token usage, and cost readout per run.

## Development

```bash
npm install
npm run dev
```

## Install

Signed desktop installers are attached to
[GitHub Releases](https://github.com/duszmox/rivju/releases). The small npm
bootstrapper downloads the matching installer and verifies its SHA-256 digest:

```bash
npx rivju@latest   # stable
npx rivju@next     # release candidate
npx rivju@nightly  # latest main build
```

Stable and Nightly are separate applications with separate data directories,
so they can be installed side by side. Packaged builds check their fixed update
channel after startup and every four minutes; downloading and installing an
update always requires an explicit action in Settings.

Maintainer setup and release procedures are in
[docs/releasing.md](docs/releasing.md).

The planning docs (architecture, phase briefs, and reports) live in
`docs/plan/`. Note that the Nitro/SSR deployment instructions historically in
this file are obsolete — rivju is a local Electron app, not a web service.
