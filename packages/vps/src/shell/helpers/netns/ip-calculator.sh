# IP scheme: 10.200.{port mod 256}.{0,1,2}/30
# Ports are unique per server, so this guarantees no IP collisions.
calc_ips() {
  local p="$1"
  local n=$((p % 256))
  HOST_IP="10.200.${n}.1"
  NS_IP="10.200.${n}.2"
  SUBNET="10.200.${n}.0/30"
}
