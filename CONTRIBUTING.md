# Contributing to Havk

Havk is a maintained fork of the Pi Agent Harness. Contributions are welcome, but changes should preserve Havk's small-core design and keep divergence from upstream Pi intentional and reviewable.

## Philosophy

Havk's core should remain minimal.

Prefer extensions or packages when a feature does not need to live in the core. This keeps Havk easier to maintain and makes upstream fixes easier to integrate.

When changing upstream-derived code:

- avoid unrelated refactors or formatting changes;
- preserve compatibility with upstream Pi internals unless a deliberate Havk change requires otherwise;
- keep Havk-facing identity such as the `havk` CLI, `.havk` configuration directory, and `@alfa-reza/havk` package intact;
- keep changes focused so upstream commits remain easy to review and cherry-pick.

## The One Rule

**You must understand your code.**

Using AI to help write code is fine. You are still responsible for understanding the change, reviewing generated code, and being able to explain how it interacts with the rest of the repository.

Agents working inside this repository should read and follow `AGENTS.md`.

## Issues

Before opening an issue:

- search existing issues first;
- describe the problem or request clearly;
- include a minimal reproduction when reporting a bug;
- include relevant logs and environment information;
- keep the report focused on one problem.

Security vulnerabilities should be reported according to `SECURITY.md`, not through a public issue.

## Pull Requests

Keep pull requests focused and avoid unrelated cleanup.

Before submitting a pull request, run:

```bash
npm run check
./test.sh
```

Both should pass.

Add or update tests when behavior changes.

Do not modify changelogs unless the change specifically requires it or a maintainer asks you to.

If a change modifies code inherited from upstream Pi, mention the relevant upstream commit, issue, or pull request when applicable.

## Core vs Packages

Features specific to Havk that do not require changes to the Pi-derived core should normally live in extensions or packages.

Core changes should be reserved for behavior that cannot be implemented cleanly outside the core or for changes required by the Havk distribution.

## License

By contributing, you agree that your contribution is provided under the repository's existing license.
