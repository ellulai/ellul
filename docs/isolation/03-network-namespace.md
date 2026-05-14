# Network namespace

Per-project named netns. Deterministic IP. iptables FORWARD chain enforces egress allowlist.

Source: `packages/vps/src/shell/helpers/agent-namespace/network-setup.sh`.

## Deterministic IP derivation

```bash
NS_IP_KEY=$(cat /etc/ellul/jwt-secret | tr -d '[:space:]')
NET_HASH=$(echo -n "$PROJECT" | openssl dgst -sha256 -hmac "$NS_IP_KEY" -hex | awk '{print $NF}')
OCTET1=$(( (16#${NET_HASH:0:2} % 55) + 200 ))   # 200-254
OCTET2=$(( 16#${NET_HASH:2:2} ))                # 0-255
OCTET3=$(( 16#${NET_HASH:4:2} & 0xFC ))         # 0-252 (aligned to /30)
NS_IP="10.$OCTET1.$OCTET2.$(($OCTET3 + 2))"
HOST_IP="10.$OCTET1.$OCTET2.$(($OCTET3 + 1))"
```

Properties:

- IP range: `10.200.0.0 - 10.254.255.252` (~900K /30 subnets).
- Per project, deterministic.
- Attacker without `jwt-secret` cannot pre-compute another project's IP.
- Each /30 has 4 IPs: network, host (.1), namespace (.2), broadcast.

Fallback chain for IP key:

1. `/etc/ellul/jwt-secret` (primary).
2. `/etc/machine-id` (secondary, stable across reboots).
3. Random bytes (development).

Fatal error if both are missing.

## veth pair

```bash
ip link add ea-${slug} type veth peer name vn-${slug}
ip link set ea-${slug} up
ip addr add ${HOST_IP}/30 dev ea-${slug}

ip link set vn-${slug} netns ${ns_name}
ip netns exec ${ns_name} ip link set vn-${slug} name eth0
ip netns exec ${ns_name} ip addr add ${NS_IP}/30 dev eth0
ip netns exec ${ns_name} ip link set eth0 up
ip netns exec ${ns_name} ip route add default via ${HOST_IP}
ip netns exec ${ns_name} ip link set lo up
```

`ea-` prefix on host side (matches iptables `-i ea-+` rule for MCP relay reachability). Name `eth0` inside namespace for compatibility with apps expecting it.

## /etc/hosts injection

Host's `/etc/hosts` gets a marker block:

```
# === ELLUL_EGRESS_BEGIN ===
192.168.x.y    api.anthropic.com
13.x.y.z       api.openai.com
185.199.108.133 raw.githubusercontent.com
... (one line per allowlisted domain's resolved IP)
# === ELLUL_EGRESS_END ===
```

Pre-resolved at namespace setup using `getent ahostsv4 <domain>`.

Inside the namespace, `/etc/hosts` is bind-mounted from host (or copied), so namespace sees the same entries.

`/etc/resolv.conf` inside namespace points to 8.8.8.8/1.1.1.1 — but DNS queries are blocked at the FORWARD layer, so /etc/hosts is the only way to resolve.

## Allowlist domains

```
# AI providers
opencode.ai, api.cursor.com, cursor.sh, models.dev
anthropic.com, api.anthropic.com, console.anthropic.com
openai.com, api.openai.com, auth.openai.com, chatgpt.com
generativelanguage.googleapis.com, googleapis.com

# Package managers
registry.npmjs.org, pypi.org, files.pythonhosted.org
crates.io, static.crates.io
proxy.golang.org, sum.golang.org, rubygems.org

# Code hosting
github.com, codeload.github.com, raw.githubusercontent.com
objects.githubusercontent.com, ghcr.io

# Container registry
docker.io, docker.com, registry-1.docker.io

# Platform
ellul.ai, ellul.app
```

Stored in `network-setup.sh` line 51-89.

## ipset

```bash
ipset create ellul-egress hash:ip family inet hashsize 1024 maxelem 65536 timeout 3600
```

IPs added with 1-hour TTL. Same IPs as /etc/hosts (kept in sync).

## Host-side iptables FORWARD chain

```bash
# Block DNS exfil — force /etc/hosts only
iptables -A FORWARD -s ${NS_IP}/32 -p udp --dport 53 -j DROP
iptables -A FORWARD -s ${NS_IP}/32 -p tcp --dport 53 -j DROP

# Allow host bridge for veth replies
iptables -A FORWARD -s ${NS_IP}/32 -d ${HOST_IP}/30 -j ACCEPT

# Block cloud metadata
iptables -A FORWARD -s ${NS_IP}/32 -d 169.254.0.0/16 -j DROP

# Block other namespaces (10.0.0.0/8 includes our 10.200.0.0/8 range)
iptables -A FORWARD -s ${NS_IP}/32 -d 10.0.0.0/8 -j DROP

# Block RFC1918
iptables -A FORWARD -s ${NS_IP}/32 -d 172.16.0.0/12 -j DROP
iptables -A FORWARD -s ${NS_IP}/32 -d 192.168.0.0/16 -j DROP

# Default-deny: only allow ipset matches
iptables -A FORWARD -s ${NS_IP}/32 -m set ! --match-set ellul-egress dst -j DROP
iptables -A FORWARD -s ${NS_IP}/32 -j ACCEPT

# Return traffic
iptables -A FORWARD -d ${NS_IP}/32 -m state --state ESTABLISHED,RELATED -j ACCEPT
```

`-m set ! --match-set ellul-egress dst` checks if destination IP is in the ipset; `!` negates → drop if not in ipset.

## Namespace-side firewall (INPUT chain)

```
-A INPUT -i lo -j ACCEPT
-A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
-A INPUT -s ${HOST_IP}/32 -j ACCEPT      # allow only host bridge
-A INPUT -j DROP                          # default-deny
```

Effect: only the host-side veth can initiate connections into the namespace. Other namespaces or external clients cannot reach.

## Cross-project preview DNAT

If sandbox A has read access to sandbox B with `sharePreview=true`:

```bash
# DNAT rule: A's namespace traffic to B's preview port → host's localhost
iptables -t nat -A PREROUTING -i ea-<a> \
  -d ${HOST_IP_A} -p tcp --dport ${B_PREVIEW_PORT} \
  -j DNAT --to-destination 127.0.0.1:${B_PREVIEW_PORT}
```

Inside A, `curl http://${HOST_IP_A}:4012` → DNAT → host's `127.0.0.1:4012` (B's PM2 preview).

A's agent never directly connects to B — bounces through host.

Scope: A can reach only B's preview port. Other ports are not DNATted.

## MASQUERADE for outbound

```bash
iptables -t nat -A POSTROUTING -s ${NS_IP}/32 -o eth0 -j MASQUERADE
```

(Where `eth0` is the host's outbound interface.) Translates namespace IP to host IP for outbound traffic. Combined with FORWARD allowlist, only allowlisted destinations are reachable.

## Verification

```bash
# Inside namespace
ip addr                                # eth0 with NS_IP
ping -c 1 ${HOST_IP}                   # host bridge reachable
curl -m 3 https://api.anthropic.com    # allowlisted: works
curl -m 3 https://example.com          # not allowlisted: hangs (DROP) or fails
nslookup api.anthropic.com 8.8.8.8     # DNS blocked
```

## Cross-references

- Mount layout: [02-mount-layout.md](./02-mount-layout.md).
- Cross-project: [04-cross-project-snapshots.md](./04-cross-project-snapshots.md).
- Egress filtering (host-level): [../networking/05-iptables-warden.md](../networking/05-iptables-warden.md).
