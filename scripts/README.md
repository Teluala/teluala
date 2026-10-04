# npm release tooling

The Publish workflow validates pull requests without npm publishing credentials.
For release tags, its prepare job builds, type-checks, tests, packs and validates
all four packages, then saves the tarballs and manifest before publication.
The publish job downloads those exact files and runs in the npm environment.

Release tags must match all four package versions and point to a commit on main.
Push only the reviewed release tag; merging a PR does not publish to npm.
The first release needs a direct-capable granular token with package creation
rights and bypass 2FA; a stage-only token cannot create the initial package.
Store it only in the npm environment's NPM_TOKEN secret. After initial release,
configure trusted publishing for each package and migrate to OIDC.

For local packaging verification after a full workspace build:

```sh
node scripts/release.mjs pack PATH_TO_EMPTY_ARTIFACT_DIRECTORY
node scripts/release.mjs verify PATH_TO_ARTIFACT_DIRECTORY
node --test scripts/release.test.mjs
```

The manifest records the source commit, four package versions and SHA256/SHA512
hashes. The publish command uses explicit beta/public settings and provenance.
It preflights all registry lookups and only skips versions with matching
integrity and beta tags. Network and permission errors stop the release. After npm accepts a publish,
verification bypasses cached responses and allows a bounded wait for the exact
version and beta tag to become visible. Integrity mismatches stop immediately.

If publication fails partway, use Re-run failed jobs for the publish job while
the original prepare artifacts are retained. Do not rerun all jobs to rebuild
tarballs, move the tag, or overwrite existing package versions. Download the
original artifacts for permanent release retention; workflow retention is 30
days. A workflow fix on main does not change the old tag's workflow: recovery
requiring a code change needs a separately reviewed recovery procedure.

No render smoke test is automated here. Confirm WebGPU rendering and optional
layers in a browser before tagging. Pattern checks do not certify the absence
of all personal information; review source history, public files, artifacts
and logs before pushing.
