# Chaos suite

Real-Linux integration tests for the resource-v2 architecture. See
`docs/v2/architecture/resource-v2/16-chaos-suite.md`.

Run the full suite (Linux only):

```sh
pnpm vitest run test/chaos/
```

Each test gates on `process.platform === "linux"` and skips elsewhere.
