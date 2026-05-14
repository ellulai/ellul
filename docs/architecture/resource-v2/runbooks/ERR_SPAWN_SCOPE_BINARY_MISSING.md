# ERR_SPAWN_SCOPE_BINARY_MISSING

## What the user sees

If the bridge starts at all (it shouldn't; `ExecStartPre` blocks startup), the user sees a generic spawn error on first send. More commonly: the bridge fails to start and the UI shows `ERR_BRIDGE_DOWN`.

## What the system did automatically

The bridge `ExecStartPre=/usr/bin/test -x /usr/local/bin/ellul-spawn-scope` should fail and prevent the bridge from starting. systemd reports `start-limit-hit` after 5 retries.

## What an operator should check

```sh
test -x /usr/local/bin/ellul-spawn-scope || echo "MISSING"
ls -la /usr/local/bin/ellul-spawn-scope
ls -la /etc/sudoers.d/ellul-spawn-scope
journalctl -u ellul-agent-bridge -n 50 --no-pager
```

If missing, re-deploy:

```sh
ELLUL_ONLY=spawn-scope CI_DEPLOY_TOKEN=... node scripts/release.mjs publish
```

Or as a hot fix, copy from the canonical path bundled in
`packages/vps/src/scripts/workflow/spawn-scope.ts` (the script body is the
exported string).

## Validating chaos scenario

Manual: `mv /usr/local/bin/ellul-spawn-scope /tmp; systemctl restart ellul-agent-bridge` — verify bridge fails to start cleanly.

## Past incidents

None yet.
