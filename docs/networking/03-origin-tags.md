# Origin tags

The origin tag is a hex-encoded VPS IP, used to name origin DNS records that Cloudflare's `resolveOverride` targets.

Source: `apps/api/src/services/gateway-kv.service.ts:24-31` (`ipToTag()`), `apps/api/src/services/gateway-hostname.service.ts` (`reconcileOriginRecord()`).

## ipToTag() function

```typescript
export function ipToTag(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: MD5 hash prefix (8 chars). NOT used for origin records.
    return createHash('md5').update(ip).digest('hex').slice(0, 8);
  }
  // IPv4: octet-by-octet hex encoding
  return ip
    .split('.')
    .map(n => parseInt(n).toString(16).padStart(2, '0'))
    .join('');
}
```

Examples:

- `192.168.0.1` → `c0a80001` (0xc0=192, 0xa8=168, 0x00=0, 0x01=1)
- `10.0.0.1` → `0a000001`
- `127.0.0.1` → `7f000001`

## Origin DNS records

For each VPS IP, two records (one per zone):

```
o-c0a80001.ellul.ai   A   192.168.0.1   (proxied: false, TTL: 1)
o-c0a80001.ellul.app  A   192.168.0.1   (proxied: false, TTL: 1)
```

Critical properties:

- **DNS-only.** `proxied: false`. Otherwise, the resolveOverride sub-request loops through Cloudflare's wildcard proxy.
- **TTL 1.** Allows fast updates (e.g., when VPS gets a new IP).
- **One record per IP**, not per server. Multiple shortIds can share an IP and the same origin record.

## Reconciler logic

```typescript
async function ensureOriginRecord(zoneId: string, ipAddress: string) {
  if (ipAddress.includes(':')) {
    throw new OriginRecordError('IPv6 not supported for origin A records');
  }
  
  const tag = ipToTag(ipAddress);
  const aiHost = `o-${tag}.ellul.ai`;
  const appHost = `o-${tag}.ellul.app`;
  
  await Promise.all([
    upsertOriginARecord(config.zoneId, aiHost, ipAddress),
    upsertOriginARecord(config.appZoneId, appHost, ipAddress),
  ]);
}
```

Upsert pattern:

1. Search Cloudflare for existing record by name + type.
2. If found and matches (IP correct + `proxied: false`): "unchanged".
3. If found but differs: PATCH to correct state.
4. If not found: POST to create.

## IPv6 limitation

Origin A records are IPv4-only. AAAA records would be supported in principle but `resolveOverride` requires the resolved IP to match the origin connection — and Cloudflare's edge connects to origin via IPv4 by default.

If a VPS is provisioned with only an IPv6 address, the reconciler throws and marks the server `error`.

For the user-facing implication: gateway-mode customers must have IPv4. Direct mode supports IPv6 (no Cloudflare in the path).

## /etc/ellul/origin-tag

The enforcer writes `/etc/ellul/origin-tag` on every heartbeat (idempotent, write-if-changed). The file is read by `caddy-gen` at runtime to populate the Caddy site block.

```bash
cat /etc/ellul/origin-tag
# c0a80001
```

If the file is missing or stale, Caddy's site block doesn't include the origin hostname → SNI mismatch → 421.

## Routing loop bug (and fix)

In April 2026 we had an incident where some origin records were created with `proxied: true`. Cloudflare's edge would:

1. Receive request via Worker for `<shortId>-srv.ellul.ai`.
2. Worker invokes `fetch(req, { cf: { resolveOverride: 'o-<tag>.ellul.ai' } })`.
3. Cloudflare resolves origin host. Sees `proxied: true` → routes through CF proxy again.
4. Hits `*.ellul.ai` proxied wildcard → loops back to Worker.

Customer experience: connection hangs.

Fix: reconciler explicitly checks `proxied === false` and PATCHes if not. Detects within one cycle (10 min worst case).

```typescript
if (record.content === ipAddress && record.proxied === false) {
  return { success: true, action: 'unchanged' };
}
// Else update with proxied=false
```

## Stale-record garbage collection

Reconciler runs hourly: list all `o-*` records on Cloudflare, compute set of active VPS IPs, delete records for IPs that aren't owned by any active server.

```typescript
async function gcStaleOriginRecords() {
  const activeIps = await db.query('SELECT DISTINCT ipAddress FROM servers WHERE status IN (...)');
  const activeTags = new Set(activeIps.map(ipToTag));
  
  for (const zoneId of [aiZone, appZone]) {
    const records = await listOriginRecords(zoneId);
    for (const record of records) {
      const m = record.name.match(/^o-([0-9a-f]{8})\./);
      if (!m) continue;
      const tag = m[1];
      if (activeTags.has(tag)) continue;
      
      // Skip if record is too new (might be a server provisioning right now)
      const age = Date.now() - new Date(record.created_on).getTime();
      if (age < 30 * 60 * 1000) continue;  // 30 min safety
      
      await deleteOriginRecord(zoneId, record.id);
    }
  }
}
```

The 30-min safety window prevents racing a newly-provisioned server's record creation.

If GC deletes ≥5 records in one cycle, an alert fires (signals delete-path failures elsewhere).

## What the user sees

In Cloudflare's DNS dashboard, the `*.ellul.ai` zone has many `o-<tag>` records — one per active VPS IP. Engineers occasionally need to verify these:

```bash
dig @1.1.1.1 o-c0a80001.ellul.ai +short
# 192.168.0.1
```

If the record is missing or proxied, the reconciler will fix on next cycle.

## Cross-references

- Reconciler: `apps/api/src/cron/gateway-reconciler.ts`.
- Worker uses these: [02-cloudflare-worker.md](./02-cloudflare-worker.md).
- Caddy site block construction: [04-caddy.md](./04-caddy.md).
- IPv6 implications: [../security/13-known-limitations.md](../security/13-known-limitations.md).
