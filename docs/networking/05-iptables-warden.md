# iptables and Warden

Egress firewall combining UID-based iptables redirect with the Warden Go service for DNS + transparent proxy enforcement.

Detail covered in [../abuse-protection/02-egress-filtering.md](../abuse-protection/02-egress-filtering.md). This page is the networking-perspective summary.

## Two-layer architecture

```
[agent process running as $SVC_USER]
       |
       | (outbound packet)
       v
┌────────────────────────────────────┐
│ iptables (kernel netfilter)        │
│ - UID match on $SVC_USER           │
│ - Block private nets, metadata     │
│ - REDIRECT TCP → Warden:8080       │
│ - REDIRECT DNS  → Warden:5353      │
│ - DROP everything else (free tier) │
└─────────────┬──────────────────────┘
              |
              v
┌────────────────────────────────────┐
│ Warden (Go, userspace)             │
│ - DNS resolver (5353)              │
│   - blacklist (mining, tunnels)    │
│   - rate limit, entropy check      │
│ - Transparent proxy (8080)         │
│   - SNI extraction                 │
│   - block by SNI                   │
│   - bandwidth throttle             │
└─────────────┬──────────────────────┘
              |
              v (allowed traffic)
            internet
```

## iptables on free tier

Source: `packages/ironclad/packer/scripts/warden-iptables.sh`.

Key rules in OUTPUT chain for `coder` UID:

```
DROP  -d 169.254.0.0/16    # cloud metadata
DROP  -d 10.0.0.0/8        # private nets
DROP  -d 172.16.0.0/12
DROP  -d 192.168.0.0/16
ACCEPT -d 127.0.0.0/8 -m conntrack --ctstate ESTABLISHED,RELATED   # localhost replies

ACCEPT -d 127.0.0.1 -p tcp --dport 8080   # Warden proxy
ACCEPT -d 127.0.0.1 -p udp --dport 5353   # Warden DNS
ACCEPT -d 127.0.0.53 -p udp --dport 53    # systemd-resolved
ACCEPT -d 127.0.0.1 -p tcp --dport 3005   # Shield
ACCEPT -d 127.0.0.1 -p tcp --dport 7701   # term-proxy
DROP  -d 127.0.0.0/8       # all other localhost
```

NAT chain:

```
REDIRECT -p tcp -j REDIRECT --to-port 8080         # all TCP → Warden
REDIRECT -p udp --dport 53 -j REDIRECT --to-port 5353   # DNS → Warden DNS
```

OUTPUT catch-alls:

```
DROP  -p udp ! --dport 53   # non-DNS UDP
DROP  -p icmp                # ICMP tunneling
DROP  -p 41                  # IP-in-IP
DROP  -p 47                  # GRE
DROP  -p 50                  # ESP
DROP                         # everything else
```

## iptables on paid tier

Source: `packages/ironclad/packer/scripts/warden-iptables-dev.sh`.

Same private-net blocks. But:

- No catch-all DROP (dev gets unrestricted internet).
- Allows namespace veth bridge (10.200.0.0/11).
- Still REDIRECTs external TCP + DNS through Warden.

```
REDIRECT -p tcp ! -d 127.0.0.0/8 -j REDIRECT --to-port 8080
REDIRECT -p udp --dport 53 ! -d 127.0.0.0/8 -j REDIRECT --to-port 5353

# VPN/tunnel ports blocked
DROP  -p udp --dport 51820   # WireGuard
DROP  -p udp --dport 1194    # OpenVPN
DROP  -p 41                  # IP-in-IP
DROP  -p 47                  # GRE
DROP  -p 50                  # ESP
```

## Persistence

`/etc/iptables/rules.v4` — saved by `iptables-save`, restored on boot via systemd unit.

Backup at `/var/lib/ellul-iptables-fb/rules.v4` (vault-bound) for redundancy.

## Warden's two roles

### DNS resolver (5353)

UDP and TCP. Behaviour:

1. Parse query.
2. Rate limit per source IP:
   - Free tier: 50 q / 10s.
   - Paid tier: 200 q / 10s.
3. Block tunneling-prone types: NULL, TXT, ANY, MX, SRV, HINFO, NAPTR.
4. Entropy check: labels >40 chars, Shannon entropy >3.5 bits/char → NXDOMAIN.
5. Domain blacklist match → NXDOMAIN.
6. Otherwise: forward to upstream resolver.

### Transparent proxy (8080)

Receives traffic via iptables REDIRECT. Uses `SO_ORIGINAL_DST` to recover original destination.

1. Read TLS ClientHello (no decryption).
2. Extract SNI.
3. Apply rules in order:
   - `*.ellul.ai`, `*.ellul.app` → ALLOW always.
   - Blacklisted (mining, tunnels, cloud APIs depending on tier) → BLOCK.
   - Stratum mining ports → BLOCK.
   - tunnel_guard mode → ALLOW non-blacklisted.
4. Forward TCP raw (no MITM).
5. Apply bandwidth throttle (free tier: 500 KB/s).

## Verification on a VPS

```bash
# Effective iptables rules
sudo iptables-save | grep "uid-owner $SVC_USER"

# Active redirects
sudo iptables -t nat -L OUTPUT -v -n | grep uid-owner

# Warden listening
sudo ss -tlnp | grep -E '(8080|5353)'

# Warden logs
sudo journalctl -u ellul-warden -n 50

# Test DNS blocking
dig @127.0.0.1 -p 5353 ngrok.com +short  # should return nothing
dig @127.0.0.1 -p 5353 anthropic.com +short  # should return IPs
```

## Integration with namespaces

Per-project namespaces have their own FORWARD chain rules in addition to OUTPUT-chain UID-based rules. See [../isolation/03-network-namespace.md](../isolation/03-network-namespace.md).

The egress allowlist (ipset `ellul-egress`) and per-project `/etc/hosts` are populated from the same allowlist as Warden's domain rules. Kept in sync at namespace setup.

## Cross-references

- Detailed egress: [../abuse-protection/02-egress-filtering.md](../abuse-protection/02-egress-filtering.md).
- Mining detection: [../abuse-protection/01-miner-detection.md](../abuse-protection/01-miner-detection.md).
- Per-project namespace network: [../isolation/03-network-namespace.md](../isolation/03-network-namespace.md).
