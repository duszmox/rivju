# Phase 9 report

## Distribution

Added hosted CircleCI workflows for Nightly, release-candidate, and stable
channels. Each platform builds independently, while one release job assembles
the artifacts, merges the two macOS update manifests, writes SHA-256 checksums,
and promotes a draft to an immutable GitHub Release only after all uploads
succeed. Candidate and stable jobs require approval; Nightly runs for every
push to `main`.

The public `rivju` npm package is a small, dependency-free bootstrapper rather
than the Electron application. It resolves the installer for the package's
exact version, downloads it from GitHub Releases, verifies `SHA256SUMS`, and
opens it. After a one-time manual package bootstrap, CircleCI publishes through
npm's OIDC trusted-publisher flow.

## Application updates

Stable and Nightly builds use distinct application IDs, names, and data
directories. Packaged apps check their fixed GitHub channel 15 seconds after
startup and every four minutes. Settings exposes status, release notes,
progress, manual download, and manual restart/install. Installation is blocked
while any review is queued or running.

Before an existing stamped database applies a new migration, rivju creates a
SQLite backup and retains the newest three. A schema stamp not present in the
bundled migration journal stops startup with a downgrade/newer-database error.

## Operational notes

The signing and trusted-publisher setup is documented in `docs/releasing.md`.
CircleCI does not support npm provenance statements, and GitHub artifact
attestations require GitHub Actions, so neither is claimed. Checksums, macOS
signing/notarization, Windows Trusted Signing for candidates and stable
releases, immutable assets, and OIDC npm publishing are retained. Windows
Nightlies remain unsigned until trusted signing is configured.

Native Windows review sessions explicitly disable Claude Code's unsupported
OS sandbox. WSL2 sessions still use the Linux sandbox, and rivju's read-only
tool policy remains active on both.

## Verification

- CircleCI CLI accepts `.circleci/config.yml` as valid.
- `npx tsc --noEmit`, `npm run lint`, and the release-file formatting check
  pass.
- The full Vitest suite passes: 14 files and 133 tests.
- Seven release metadata/manifest tests and four npm installer tests pass,
  including invocation through npm's executable symlink.
- `npm pack --dry-run` contains exactly four npm package files and produces a
  2.9 kB tarball.
- `npm run build`, `npm run dist:dir`, and an unsigned local `npm run dist:mac`
  pass. The macOS build produces the expected DMG, ZIP, blockmaps, and
  `latest-mac.yml` names. Signing remains enforced only in CircleCI release
  jobs, where credentials are available.
