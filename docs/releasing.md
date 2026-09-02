# Releasing rivju

CircleCI builds every desktop target on hosted executors. GitHub Releases is
the canonical artifact store; the `rivju` npm package is only a checksum-
verifying installer bootstrapper.

## Channels

| Channel   | Trigger                          | GitHub release                             | npm dist-tag | Desktop identity |
| --------- | -------------------------------- | ------------------------------------------ | ------------ | ---------------- |
| Nightly   | Every push to `main`             | `vX.Y.Z-nightly.YYYYMMDD.BUILD` prerelease | `nightly`    | `rivju Nightly`  |
| Candidate | `vX.Y.Z-rc.N` tag, then approval | prerelease                                 | `next`       | stable identity  |
| Stable    | `vX.Y.Z` tag, then approval      | latest release                             | `latest`     | `rivju`          |

Release and candidate tags must point to commits on `main`. Versions and
uploaded asset names are immutable. Retrying a publish leaves an existing asset
unchanged instead of replacing it. GitHub Releases remain drafts until every
artifact and checksum has uploaded successfully.

## CircleCI setup

Connect `github.com/duszmox/rivju` as a CircleCI project and use the checked-in
`.circleci/config.yml`. Create a restricted CircleCI context named `release`.
Limit it to maintainers and protect it with the same release controls as the
repository.

Add these variables to the `release` context:

- `GH_TOKEN`: fine-grained GitHub token for `duszmox/rivju`, with repository
  Contents read/write permission.
- `CSC_LINK` and `CSC_KEY_PASSWORD`: Developer ID Application certificate and
  password used by electron-builder.
- `APPLE_API_KEY`: contents of the App Store Connect `.p8` key.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: App Store Connect key identifiers.
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`: Azure
  workload credentials.
- `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, and
  `AZURE_TRUSTED_SIGNING_PROFILE`: Azure Trusted Signing configuration.
- `WINDOWS_PUBLISHER_NAME`: the certificate subject expected by the NSIS
  installer.

The Linux build and ordinary quality jobs receive no release context.

For npm trusted publishing, configure the existing `rivju` package on npm with
CircleCI as its trusted publisher. npm asks for the CircleCI organization ID,
project ID, pipeline definition ID, VCS origin
`github.com/duszmox/rivju`, and optionally the `release` context ID. The publish
job obtains a short-lived npm token from CircleCI OIDC; do not add a long-lived
`NPM_TOKEN`.

CircleCI trusted publishing requires Node 22.14 or newer and npm 11.5.1 or
newer. The workflow installs the current npm 11 before publishing.

## First npm publication

npm cannot attach a trusted publisher until the package exists. Bootstrap it
once:

1. Create and push the protected tag `v0.1.0-rc.0` on a commit from `main`.
2. Approve `hold-next` in CircleCI. Let the signed GitHub prerelease finish.
   The npm job is expected to fail until trusted publishing is configured.
3. From that exact tagged checkout, sign in to npm with the owner account and
   run `cd npm/rivju && npm publish --tag next` with 2FA.
4. Configure the CircleCI trusted publisher on npm using the identifiers above.
5. Future candidate, Nightly, and stable npm publications use OIDC only.

Before the manual publish, inspect `npm pack --dry-run`. The package must contain
only its package metadata, README, and `bin/rivju.js`.

## Stable release

After validating a candidate, create and push `v0.1.0` (or the next strict
semantic version) on a commit from `main`. Approve `hold-stable` in CircleCI.
The workflow runs formatting, lint, types, and tests; builds and signs macOS
arm64/x64, Windows x64, and Linux x64 AppImage artifacts; publishes the GitHub
Release and update manifests; then assigns the matching npm version to
`latest`.

## Nightly release

Every push to `main` publishes a version derived from the next stable patch,
UTC date, and CircleCI build number. Nightly publishing has no manual gate.
Stable installations never switch to the Nightly feed, and Nightly
installations never switch to stable.

## Integrity and CI limitations

All release downloads have a `SHA256SUMS` manifest. macOS artifacts are signed
and notarized; Windows artifacts use Azure Trusted Signing. The npm
bootstrapper verifies the selected artifact against the manifest before opening
it.

npm provenance statements are not available for CircleCI trusted-publisher
workflows, and GitHub artifact attestations are specific to GitHub Actions.
This pipeline therefore does not claim either feature. OIDC npm publishing,
platform signing, immutable GitHub assets, and checksums remain enforced.

Native stores and package registries are intentionally deferred. The current
targets are GitHub Releases and npm only.
