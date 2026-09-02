# Phase 8 report

## Ticket navigation

Added generic ticket navigation modeled on JetBrains issue navigation rules.
Users can define up to 20 rules in Settings. Each rule maps a JavaScript regular
expression for ticket IDs to an HTTP or HTTPS URL template. Templates support
`$0` for the complete match, numbered capture groups such as `$1`, and `$$` for
a literal dollar sign.

The main process scans the merge request title and returns the exact character
ranges for linked ticket IDs. It also fetches merge request commits through
GitLab REST v4 and scans their messages. Ticket IDs in the page title are
clickable. A separate list deduplicates commit references by ticket URL and
shows how many commits mention each ticket. A failure to fetch commits does not
block the rest of the merge request page.

Rules use the existing SQLite `setting` table, so this change needs no schema
migration or new dependency. GitLab remains read-only.

## Verification

- 30 ticket-navigation and GitLab integration tests pass.
- `npx tsc --noEmit` passes.
- `npm run lint` passes.
- `npm run build` passes.
- The full suite has 128 passing tests and one unrelated failure in
  `skills.test.ts`. The test compares the macOS aliases `/var/...` and
  `/private/var/...` as literal strings.

## Deviations

The original plan ends at Phase 7. This work is recorded as Phase 8 because it
is a post-v1 feature and does not fit an existing phase without violating its
scope.
