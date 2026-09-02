# Phase 9 — Distribution and updates

## Goal

Ship signed stable and release-candidate desktop builds plus Nightly builds
through CircleCI, expose them through GitHub Releases and a minimal npm
installer, and let packaged apps update safely from their fixed channel.

## Scope

- Hosted CircleCI builds for macOS arm64/x64, Windows x64, and Linux x64
  AppImage.
- Nightly releases on every `main` push; approved candidate and stable tag
  workflows.
- macOS notarization, Windows Trusted Signing for candidates and stable
  releases, unsigned Windows Nightlies, release checksums, and npm OIDC.
- A dependency-free npm bootstrapper that downloads a matching GitHub artifact
  and verifies its checksum.
- Separate Stable and Nightly identities and user-data paths.
- startup, periodic, and manual update checks with manual download/install.
- database compatibility guard and three pre-migration backups.
- release documentation and MIT licensing.

## Acceptance

- Type checking, lint, formatting checks for release-owned files, unit tests,
  production build, release metadata tests, and npm package tests pass.
- The CircleCI YAML parses and all workflow dependencies resolve.
- A local unpacked Electron distribution can be assembled without signing.
- No credentials are committed.
