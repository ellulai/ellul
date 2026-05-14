  # ── HOST-SIDE NETWORK SETUP ──
  # All network config runs on the host BEFORE unshare. The unshare only
  # creates mount+PID namespaces and joins the pre-created named netns.
  # SECURITY: Use HMAC-SHA256 keyed by server-local secret to derive IPs.
  # Prevents attackers from pre-computing namespace IPs from project slugs.
  NS_IP_KEY=""
  [ -f /etc/ellul/jwt-secret ] && NS_IP_KEY=$(cat /etc/ellul/jwt-secret 2>/dev/null | tr -d '[:space:]')
  [ -z "$NS_IP_KEY" ] && [ -f /etc/machine-id ] && NS_IP_KEY=$(cat /etc/machine-id 2>/dev/null | tr -d '[:space:]')
  # SECURITY: Fail hard if no cryptographic key is available. The MD5 fallback was
  # removed because it's predictable — an attacker knowing the project slug can
  # compute the namespace IP and target it. Server MUST have jwt-secret or machine-id.
  if [ -z "$NS_IP_KEY" ]; then
    echo '{"success":false,"error":"FATAL: No NS_IP_KEY available — jwt-secret and machine-id both missing"}' >&2
    exit 1
  fi
  NET_HASH=$(echo -n "$PROJECT" | openssl dgst -sha256 -hmac "$NS_IP_KEY" -hex 2>/dev/null | awk '{print $NF}')
  if [ -z "$NET_HASH" ]; then
    echo '{"success":false,"error":"FATAL: openssl HMAC-SHA256 failed — cannot derive namespace IP securely"}' >&2
    exit 1
  fi
  OCTET1=$(( (16#${NET_HASH:0:2} % 55) + 200 ))
  OCTET2=$(( 16#${NET_HASH:2:2} ))
  OCTET3=$(( 16#${NET_HASH:4:2} & 0xFC ))
  NS_IP="10.$OCTET1.$OCTET2.$(($OCTET3 + 2))"
  HOST_IP="10.$OCTET1.$OCTET2.$(($OCTET3 + 1))"
  NS_SHORT=$(echo "$PROJECT" | sed 's/^sbx-//')
  VETH_HOST="ea-$NS_SHORT"
  VETH_NS="vn-$NS_SHORT"
  NS_NETNS="ellul-$PROJECT"

  ns_phase_log netns-create begin "nsIp=$NS_IP hostIp=$HOST_IP"
  # The named-netns bind mount must land in PID 1's mount NS so the
  # transient anchor unit (started by systemd in PID 1's NS) can find it.
  /usr/bin/nsenter --target 1 --mount -- $IP netns add "$NS_NETNS"
  $IP link add "$VETH_HOST" type veth peer name "$VETH_NS"
  $IP link set "$VETH_NS" netns "$NS_NETNS"

  # Host-side veth config
  $IP addr add "$HOST_IP/30" dev "$VETH_HOST"
  $IP link set "$VETH_HOST" up
  # /proc/sys is RO under bridge's ProtectKernelTunables=true; route via PID 1.
  /usr/bin/nsenter --target 1 --mount -- /usr/bin/sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward" 2>/dev/null || true
  /usr/bin/nsenter --target 1 --mount -- /usr/bin/sh -c "echo 1 > /proc/sys/net/ipv4/conf/$VETH_HOST/route_localnet" 2>/dev/null || true
  /usr/bin/nsenter --target 1 --mount -- /usr/bin/sh -c "echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-ellul-netns.conf" 2>/dev/null || true
  ns_phase_log netns-create end

  # ── Egress allowlist dependency ──
  # The FORWARD chain below references ipset `ellul-egress`; iptables-restore
  # fails the whole batch if the set is missing. Provisioning's egress-dns-setup
  # creates it, but ensure it exists here too (idempotent).
  ipset list -n ellul-egress >/dev/null 2>&1 || \
    ipset create ellul-egress hash:ip family inet hashsize 1024 maxelem 65536 timeout 3600

  # ── Egress allowlist via /etc/hosts injection (no DNS resolver needed) ──
  # Pre-resolve allowlisted domains on the host (where DNS works), populate
  # both the ellul-egress ipset AND host /etc/hosts so the namespace's NSS
  # resolves them without ever sending a DNS query. All other names fail
  # NSS (no DNS server reachable — see explicit FORWARD DROP below) and the
  # FORWARD ipset rule blocks every IP that isn't in the allowlist.
  #
  # Trade-off: host /etc/hosts gains entries inside an ELLUL_EGRESS_BEGIN/END
  # marker block. Other host services that resolve these names use our
  # cached IP — same outcome as if they had done their own DNS lookup at
  # the same instant. Teardown removes the block.
  #
  # Why not dnsmasq+DNAT: the DNAT counter increments but the packet never
  # reaches dnsmasq's socket. Same result with 127.0.0.99 (loopback) or
  # 10.222.222.1 (dummy interface). Routing/conntrack interaction on
  # iptables-nft drops the packet between PREROUTING NAT and INPUT chain
  # in a way that doesn't surface in any iptables counter. Bypassing DNS
  # entirely sidesteps the whole class of issue.
  ns_phase_log egress-resolve begin
  _HOSTS_TMP="$(mktemp /tmp/.ellul-hosts.XXXXXX)"
  printf '# === ELLUL_EGRESS_BEGIN ===\n' > "$_HOSTS_TMP"
  _RESOLVED_COUNT=0
  for _DOMAIN in opencode.ai api.cursor.com cursor.sh \
                  api2.cursor.sh repo42.cursor.sh \
                  agentn.global.api5.cursor.sh agentn.global.api2.cursor.sh \
                  models.dev \
                  anthropic.com api.anthropic.com console.anthropic.com \
                  claude.ai claude.com platform.claude.com \
                  openai.com api.openai.com auth.openai.com \
                  chatgpt.com \
                  generativelanguage.googleapis.com googleapis.com \
                  registry.npmjs.org pypi.org files.pythonhosted.org \
                  crates.io static.crates.io \
                  proxy.golang.org sum.golang.org rubygems.org \
                  github.com codeload.github.com raw.githubusercontent.com \
                  objects.githubusercontent.com ghcr.io \
                  docker.io docker.com registry-1.docker.io \
                  $(cat /etc/ellul/platform-zone 2>/dev/null) \
                  api.$(cat /etc/ellul/platform-zone 2>/dev/null) \
                  $(cat /etc/ellul/app-zone 2>/dev/null); do
    for _IP in $(getent ahostsv4 "$_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u); do
      ipset add ellul-egress "$_IP" -exist 2>/dev/null || true
      printf '%s %s\n' "$_IP" "$_DOMAIN" >> "$_HOSTS_TMP"
      _RESOLVED_COUNT=$((_RESOLVED_COUNT + 1))
    done
  done
  printf '# === ELLUL_EGRESS_END ===\n' >> "$_HOSTS_TMP"
  ns_phase_log egress-resolve end "ipsAdded=$_RESOLVED_COUNT"

  # Atomically swap the marker block in /etc/hosts (or append if absent).
  if grep -q '^# === ELLUL_EGRESS_BEGIN ===' /etc/hosts 2>/dev/null; then
    awk '/^# === ELLUL_EGRESS_BEGIN ===/{skip=1} !skip{print} /^# === ELLUL_EGRESS_END ===/{skip=0}' \
      /etc/hosts > "${_HOSTS_TMP}.merge"
    cat "$_HOSTS_TMP" >> "${_HOSTS_TMP}.merge"
    install -m 0644 -o root -g root "${_HOSTS_TMP}.merge" /etc/hosts
    rm -f "${_HOSTS_TMP}.merge"
  else
    cat "$_HOSTS_TMP" >> /etc/hosts
  fi
  rm -f "$_HOSTS_TMP"

  # Stop any running dnsmasq from earlier bundles — we don't use it anymore.
  # The dnsmasq-egress unit was retired when we moved to /etc/hosts injection;
  # if a legacy unit is still installed it will crash-loop forever (the log
  # path it expects is owned by `dev`, not `dnsmasq`). Disable + mask it once
  # we have systemctl available — failure is non-fatal.
  if [ -f /run/ellul-dnsmasq-egress.pid ]; then
    _OLD_DNS=$(cat /run/ellul-dnsmasq-egress.pid 2>/dev/null)
    if [ -n "$_OLD_DNS" ] && [ -r "/proc/$_OLD_DNS/comm" ] && \
       [ "$(cat /proc/$_OLD_DNS/comm 2>/dev/null)" = "dnsmasq" ]; then
      kill "$_OLD_DNS" 2>/dev/null || true
    fi
    rm -f /run/ellul-dnsmasq-egress.pid
  fi
  if command -v systemctl >/dev/null 2>&1 && \
     systemctl list-unit-files ellul-dnsmasq-egress.service 2>/dev/null | grep -q '\.service'; then
    systemctl disable --now ellul-dnsmasq-egress.service 2>/dev/null || true
    systemctl mask ellul-dnsmasq-egress.service 2>/dev/null || true
    rm -f /etc/systemd/system/ellul-dnsmasq-egress.service 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null || true
    ns_phase_log dnsmasq-legacy-disabled info
  fi

  # ── Host-side iptables (batched via iptables-restore) ──
  # Single process instead of 29 sequential fork+exec calls.
  # IMPORTANT: Raw -A lines only — no chain declarations, no :CHAIN POLICY lines.
  # --noflush preserves existing chains but flushes any chains declared in the input.
  # By omitting chain declarations, UFW chains and host rules are untouched.

  # First: clean up any stale rules from a previous namespace with the same IP
  $IPTABLES -t nat -D POSTROUTING -s $NS_IP/32 -j MASQUERADE 2>/dev/null || true
  # Clean up legacy DNS DNAT targets from earlier bundles (loopback variants
  # that didn't reliably route the reply path). The current target is
  # 10.222.222.1 on the dummy-egress interface.
  for _DNAT_IP in 10.222.222.1 127.0.0.99 127.0.0.54 127.0.0.53; do
    $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p udp --dport 53 -j DNAT --to-destination $_DNAT_IP:53 2>/dev/null || true
    $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 53 -j DNAT --to-destination $_DNAT_IP:53 2>/dev/null || true
    $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -p udp --dport 53 -j DNAT --to-destination $_DNAT_IP:53 2>/dev/null || true
    $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -p tcp --dport 53 -j DNAT --to-destination $_DNAT_IP:53 2>/dev/null || true
  done
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790 2>/dev/null || true
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 7701 -j DNAT --to-destination 127.0.0.1:7701 2>/dev/null || true
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 7702 -j DNAT --to-destination 127.0.0.1:7702 2>/dev/null || true
  $IPTABLES -D OUTPUT -d $NS_IP/32 -j ACCEPT 2>/dev/null || true
  $IPTABLES -D FORWARD -d $NS_IP/32 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -j ACCEPT 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -m set ! --match-set ellul-egress dst -j DROP 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 192.168.0.0/16 -j DROP 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 172.16.0.0/12 -j DROP 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 10.0.0.0/8 -j DROP 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 169.254.0.0/16 -j DROP 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -d $HOST_IP/30 -j ACCEPT 2>/dev/null || true

  # Clean up old explicit port-53 DROP rule so we don't stack duplicates.
  $IPTABLES -D FORWARD -s $NS_IP/32 -p udp --dport 53 -j DROP 2>/dev/null || true
  $IPTABLES -D FORWARD -s $NS_IP/32 -p tcp --dport 53 -j DROP 2>/dev/null || true

  # Then: batch-add all rules in one iptables-restore call. FORWARD chain
  # order matters — with -I (insert at pos 1), each line pushes the previous
  # down. iptables-restore processes lines top-to-bottom, so the LAST -I line
  # becomes rule #1 in the chain. Write in REVERSE of desired evaluation:
  #
  # Desired evaluation (top to bottom, port-53 DROP added at top to block
  # DNS-tunnel exfil — namespace must use /etc/hosts only):
  #   1. DROP   -s NS -p udp/tcp --dport 53        (block DNS exfil — namespace
  #                                                 must use /etc/hosts only)
  #   2. ACCEPT -s NS -d HOST_IP/30                (allow host veth)
  #   3. DROP   -s NS -d 169.254.0.0/16            (block cloud metadata)
  #   4. DROP   -s NS -d 10.0.0.0/8                (block cross-namespace)
  #   5. DROP   -s NS -d 172.16.0.0/12             (block RFC1918)
  #   6. DROP   -s NS -d 192.168.0.0/16            (block RFC1918)
  #   7. DROP   -s NS not in ipset ellul-egress    (egress allowlist)
  #   8. ACCEPT -s NS                              (allow ipset-matching)
  #   9. ACCEPT -d NS RELATED,ESTABLISHED          (return traffic)
  _NAT_RULES="*nat
-A POSTROUTING -s $NS_IP/32 -j MASQUERADE
-A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790
-A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 7701 -j DNAT --to-destination 127.0.0.1:7701
-A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 7702 -j DNAT --to-destination 127.0.0.1:7702
COMMIT
*filter
-I OUTPUT -d $NS_IP/32 -j ACCEPT
-I FORWARD -d $NS_IP/32 -m state --state RELATED,ESTABLISHED -j ACCEPT
-I FORWARD -s $NS_IP/32 -j ACCEPT
-I FORWARD -s $NS_IP/32 -m set ! --match-set ellul-egress dst -j DROP
-I FORWARD -s $NS_IP/32 -d 192.168.0.0/16 -j DROP
-I FORWARD -s $NS_IP/32 -d 172.16.0.0/12 -j DROP
-I FORWARD -s $NS_IP/32 -d 10.0.0.0/8 -j DROP
-I FORWARD -s $NS_IP/32 -d 169.254.0.0/16 -j DROP
-I FORWARD -s $NS_IP/32 -d $HOST_IP/30 -j ACCEPT
-I FORWARD -s $NS_IP/32 -p tcp --dport 53 -j DROP
-I FORWARD -s $NS_IP/32 -p udp --dport 53 -j DROP
COMMIT"
  ns_phase_log iptables-restore begin
  echo "$_NAT_RULES" | $IPTABLES-restore --noflush
  ns_phase_log iptables-restore end
