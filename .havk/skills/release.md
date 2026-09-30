---
name: release
description: Prepare, publish, verify, and recover Havk releases. Use for release preparation, local release smoke tests, publishing, and failed release CI.
---

# Releasing Havk

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/havk-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/havk-local-release/node/havk --help
   /tmp/havk-local-release/node/havk --version
   /tmp/havk-local-release/node/havk --list-models
   /tmp/havk-local-release/node/havk -p "Say exactly: ok"
   /tmp/havk-local-release/node/havk

   # Bun binary smoke tests
   /tmp/havk-local-release/bun/havk --help
   /tmp/havk-local-release/bun/havk --version
   /tmp/havk-local-release/bun/havk --list-models
   /tmp/havk-local-release/bun/havk -p "Say exactly: ok"
   /tmp/havk-local-release/bun/havk
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/havk-local-release/node/havk` and `/tmp/havk-local-release/bun/havk` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes the release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. CI builds and smoke-tests Havk binaries, publishes the npm packages, stages the GitHub Release, and publishes the GitHub Release only after the required jobs succeed.

5. **If CI publishing fails**: inspect the failed job. The npm publish helper is idempotent and skips package versions already present on npm. Rerun the failed job or workflow after fixing CI, GitHub Release, or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
