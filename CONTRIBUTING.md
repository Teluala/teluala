# Contributing to Teluala

Thank you for helping improve Teluala.

## Before opening a change

- Use English for issues, pull requests, comments, documentation, and code
  comments.
- Keep the engine framework-independent and avoid runtime dependencies unless
  there is a demonstrated need.
- Keep data formats and application-specific policy outside the engine core.
- Open an issue before proposing a large API or rendering-architecture change.

## Development

```sh
npm install
npm test
```

`npm test` builds the package and runs the browser-independent test suite.
Changes to rendering or interaction also require a WebGPU browser smoke test.

## Code style

Use two-space indentation and the included Prettier configuration. Keep the
copyright and SPDX header in source files. Format code with Prettier 3.6.2;
formatting tools are not runtime dependencies.

## Commits

Write concise commit messages in English. Do not include references to private
systems or unpublished issue trackers.

## Pull requests

Describe the user-visible effect, tests performed, and any compatibility risk.
Keep unrelated changes in separate pull requests.
