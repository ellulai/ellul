exec)
    if [ -z "$NS_NAME" ]; then
      echo '{"success":false,"error":"Usage: exec <ns-name>"}'
      exit 1
    fi

    if ! ip netns list | grep -q "^${NS_NAME} "; then
      echo '{"success":false,"error":"Namespace does not exist"}'
      exit 1
    fi

    # Read config from stdin: { command, cwd, env, writableDirs? }
    CONFIG=$(cat)

    COMMAND=$(echo "$CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin)['command'])")
    CWD=$(echo "$CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin)['cwd'])")
    ENV_EXPORTS=$(echo "$CONFIG" | python3 -c "
import sys, json
env = json.load(sys.stdin).get('env', {})
for k, v in env.items():
    # Escape for shell
    escaped = v.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')
    print(f'export {k}=\"{escaped}\"')
")
    # Parse writable dirs — relative paths that get private tmpfs mounts
    # (used for dev server build caches: .next/, node_modules/.vite/, etc.)
    WRITABLE_DIRS=$(echo "$CONFIG" | python3 -c "
import sys, json
dirs = json.load(sys.stdin).get('writableDirs', [])
for d in dirs:
    print(d)
" 2>/dev/null || true)

    DATA_DIR="/var/lib/ellul-shielded/${NS_NAME}"

    # Enter network namespace, create mount namespace, exec as shield-runner
    ip netns exec "$NS_NAME" unshare --mount bash -c "
      # Rule 1: Source code — bind mount (still writable for now)
      mount --bind \"$CWD\" /app

      # Rule 1b: Writable build cache overlays — mount BEFORE R/O remount
      # These dirs get private tmpfs so the dev server can write build artifacts
      # (.next/, node_modules/.vite/, etc.) while source stays read-only.
      # The agent cannot see these private mounts.
      while IFS= read -r wdir; do
        [ -z \"\$wdir\" ] && continue
        mkdir -p \"/app/\$wdir\" 2>/dev/null || true
        mount -t tmpfs -o size=512M tmpfs \"/app/\$wdir\"
        # Ensure shield-runner can write to the tmpfs
        chown shield-runner:shield \"/app/\$wdir\"
      done <<< \"$WRITABLE_DIRS\"

      # Rule 1c: NOW remount source as read-only
      # The tmpfs mounts above are independent mount points — they stay writable.
      mount -o remount,ro,bind /app

      # Rule 2: Data vault (full access for shield-runner)
      mount --bind \"$DATA_DIR\" /data

      # Private tmpfs overlays — prevent exfiltration via shared writable dirs.
      # Pre-planted code (fs.writeFileSync('/tmp/.s', JSON.stringify(process.env)))
      # writes to private tmpfs invisible to the agent on the host.
      mount -t tmpfs -o size=256M,noexec,nosuid,nodev tmpfs /tmp
      mount -t tmpfs -o size=128M,noexec,nosuid,nodev tmpfs /var/tmp
      mount -t tmpfs -o size=64M,noexec,nosuid,nodev tmpfs /dev/shm

      # DNS resolution
      if [ -f /etc/netns/${NS_NAME}/resolv.conf ]; then
        mount --bind /etc/netns/${NS_NAME}/resolv.conf /etc/resolv.conf
      fi

      # Drop to shield-runner, disable core dumps, exec the app
      cd /app
      exec runuser -u shield-runner -- bash -c \"ulimit -c 0
$ENV_EXPORTS
$COMMAND\"
    "
    ;;
