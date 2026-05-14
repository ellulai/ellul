# ERR_PORT_BIND_TIMEOUT

## What the user sees

`PreviewStatusPill` flips to `failed`. Banner: "Preview took too long to bind; check the dev command."

## What the system did automatically

The preview unit started, but no process bound the assigned port within `PORT_BIND_TIMEOUT_MS` (default 90 s). The `preview` state machine transitioned to `failed`. AdmissionService released the reserved RAM.

## What an operator should check

```sh
journalctl -u ellul-preview@<inst>.service -n 200 --no-pager
ls /home/dev/<projectDir>/.ellul/preview.json
cat /home/dev/<projectDir>/package.json
```

Common causes:

- Wrong dev command in `.ellul/preview.json` (e.g. `npm start` for a non-Node project).
- Dependency install still running and blocking; the unit logs `installing: true` in this case.
- Port already bound by another process.

User retries with the "Restart" button; the reconciler at next tick will also retry.

## Validating chaos scenario

`preview-evict-storm.test.ts` covers the happy path; the failure path is exercised in `preview.machine.test.ts`.

## Past incidents

None yet.
