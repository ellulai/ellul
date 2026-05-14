#!/bin/bash
# shield-ssh-key-mgr — privileged SSH authorized_keys manager.
#
# Called by sovereign-shield via:
#   sudo /usr/local/bin/shield-ssh-key-mgr add  '<pubkey-line>'
#   sudo /usr/local/bin/shield-ssh-key-mgr remove <SHA256:fingerprint>
#   sudo /usr/local/bin/shield-ssh-key-mgr list
#
# Why this exists: sovereign-shield runs as `shield-runner` (uid 995). The
# authorized_keys file is 0600 root:root (sshd reads it via AuthorizedKeysCommand
# running as root — see /usr/local/bin/ellul-ssh-authorized-keys). shield-runner
# cannot read or write that file directly. Earlier code path tried `appendFileSync`
# from Node, then chowned to root:root — first append succeeded (parent dir is
# group-writable for shield), then verification read returned EACCES (caught
# silently, returned []), so the route threw "Key was not written"; subsequent
# attempts failed with EACCES on append. This wrapper performs both reads and
# writes as root with strict input validation, restoring the verify path.
#
# Hardcoded paths, action whitelist, regex-validated arguments — zero injection
# surface. Wrapper is chattr +i in the sudo-immutability pass.
set -euo pipefail

ACTION="${1:-}"
ARG="${2:-}"

[ -f /etc/default/ellul ] && . /etc/default/ellul
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/${SVC_USER}"

AUTH_KEYS_DIR="/etc/ssh/authorized_keys"
AUTH_KEYS_FILE="${AUTH_KEYS_DIR}/${SVC_USER}"

# Boot-partition fallback. Every write must hit BOTH paths so the user is
# never locked out if the vault overlay activates over an empty source.
# The bootstrap partition is on the unencrypted root FS and never
# bind-mounted; ellul-ssh-authorized-keys reads from it on vault-miss.
FALLBACK_KEYS_DIR="/etc/ellul-bootstrap/authorized_keys"
FALLBACK_KEYS_FILE="${FALLBACK_KEYS_DIR}/${SVC_USER}"

# Always operate on the bind target — never the vault source path. The shield
# systemd unit pins ProtectHome=read-only, and that mount namespace is
# inherited by every sudo-spawned child (sudo doesn't escape namespaces). So
# even though this wrapper runs as root, touching anything under
# /home/dev/.ellul-vault/ returns EROFS. The bind target is in shield's
# ReadWritePaths list, and (when /etc/ssh/authorized_keys is a live bind
# mount) writes pass through to the vault for free. The vault directory
# itself must be pre-created at provisioning / wake-mount time — see
# packages/vps/src/shell/helpers/system/mount-volume/vault-restore.sh.
mkdir -p "${AUTH_KEYS_DIR}"
chown root:shield "${AUTH_KEYS_DIR}" 2>/dev/null || true
chmod 0770 "${AUTH_KEYS_DIR}"

mkdir -p "${FALLBACK_KEYS_DIR}"
chown root:shield "${FALLBACK_KEYS_DIR}" 2>/dev/null || true
chmod 0770 "${FALLBACK_KEYS_DIR}"

# --- Helpers ------------------------------------------------------------------

# Compute SHA256 SSH fingerprint from a single key line. Empty on failure.
fingerprint_of() {
  local _line="$1"
  ssh-keygen -lf - <<<"${_line}" 2>/dev/null | awk '{print $2}'
}

# Write file content from $1 atomically with 0600 root:root, restoring chattr +i.
# Use install(1) for atomic rename; chattr -i first if file existed.
atomic_install() {
  local _src="$1" _dst="$2"
  if [ -f "${_dst}" ]; then
    chattr -i "${_dst}" 2>/dev/null || true
  fi
  install -m 0600 -o root -g root "${_src}" "${_dst}"
  chattr +i "${_dst}" 2>/dev/null || true
}

# Atomically install the same content to BOTH the primary path (vault-bound)
# and the boot-partition fallback. Either failing is a hard error: SSH access
# is the load-bearing recovery channel and we'd rather refuse the write than
# accept a half-applied state where the two paths disagree.
atomic_install_both() {
  local _src="$1"
  atomic_install "${_src}" "${AUTH_KEYS_FILE}"
  atomic_install "${_src}" "${FALLBACK_KEYS_FILE}"
}

# --- Actions ------------------------------------------------------------------

case "${ACTION}" in
  add)
    if [ -z "${ARG}" ]; then
      echo "Usage: shield-ssh-key-mgr add '<pubkey-line>'" >&2
      exit 1
    fi
    # Reject any control character, including newlines — a single-line invariant.
    # Done in pure bash (no grep -P / locale dependencies). Strip ASCII control
    # bytes 0x00-0x1f and 0x7f via tr; if the byte length changes, reject.
    _stripped=$(printf '%s' "${ARG}" | LC_ALL=C tr -d '\000-\037\177')
    if [ "${#_stripped}" != "${#ARG}" ]; then
      /usr/bin/logger -t shield-ssh-key-mgr -p auth.warning "REJECTED add: control chars in key"
      echo "shield-ssh-key-mgr: control characters not permitted" >&2
      exit 1
    fi
    unset _stripped
    # Validate key-line shape: <type> <base64-data> [optional comment]
    if ! printf '%s\n' "${ARG}" | grep -qE '^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( .*)?$'; then
      /usr/bin/logger -t shield-ssh-key-mgr -p auth.warning "REJECTED add: bad key format"
      echo "shield-ssh-key-mgr: invalid key format" >&2
      exit 1
    fi
    NEW_FP=$(fingerprint_of "${ARG}")
    if [ -z "${NEW_FP}" ]; then
      /usr/bin/logger -t shield-ssh-key-mgr -p auth.warning "REJECTED add: ssh-keygen could not parse key"
      echo "shield-ssh-key-mgr: could not parse key" >&2
      exit 1
    fi
    # Build new file content: existing keys minus any duplicate of NEW_FP, then append.
    TMP=$(mktemp)
    trap 'rm -f "${TMP}"' EXIT
    if [ -f "${AUTH_KEYS_FILE}" ]; then
      while IFS= read -r line || [ -n "${line}" ]; do
        if [ -z "${line}" ] || [ "${line#\#}" != "${line}" ]; then
          printf '%s\n' "${line}" >> "${TMP}"
          continue
        fi
        EX_FP=$(fingerprint_of "${line}")
        if [ -n "${EX_FP}" ] && [ "${EX_FP}" = "${NEW_FP}" ]; then
          # Duplicate fingerprint — drop existing line, will append the new one
          continue
        fi
        printf '%s\n' "${line}" >> "${TMP}"
      done < "${AUTH_KEYS_FILE}"
    fi
    printf '%s\n' "${ARG}" >> "${TMP}"
    atomic_install_both "${TMP}"
    /usr/bin/logger -t shield-ssh-key-mgr -p auth.info "ADDED fp=${NEW_FP} user=${SVC_USER}"
    printf '%s\n' "${NEW_FP}"
    ;;

  remove)
    if [ -z "${ARG}" ] || ! printf '%s' "${ARG}" | grep -qE '^SHA256:[A-Za-z0-9+/]+=*$'; then
      /usr/bin/logger -t shield-ssh-key-mgr -p auth.warning "REJECTED remove: bad fingerprint"
      echo "shield-ssh-key-mgr: invalid fingerprint" >&2
      exit 1
    fi
    # Source-of-truth for the rebuild is whichever path actually has bytes.
    # On a corrupted-vault box the primary may be missing while the fallback
    # is intact; remove must still succeed end-to-end so the operator gets a
    # consistent state.
    SOURCE=""
    [ -s "${AUTH_KEYS_FILE}" ] && SOURCE="${AUTH_KEYS_FILE}"
    [ -z "${SOURCE}" ] && [ -s "${FALLBACK_KEYS_FILE}" ] && SOURCE="${FALLBACK_KEYS_FILE}"
    if [ -z "${SOURCE}" ]; then
      atomic_install_both /dev/null
      exit 0
    fi
    TMP=$(mktemp)
    trap 'rm -f "${TMP}"' EXIT
    REMOVED=0
    while IFS= read -r line || [ -n "${line}" ]; do
      if [ -z "${line}" ] || [ "${line#\#}" != "${line}" ]; then
        printf '%s\n' "${line}" >> "${TMP}"
        continue
      fi
      EX_FP=$(fingerprint_of "${line}")
      if [ -n "${EX_FP}" ] && [ "${EX_FP}" = "${ARG}" ]; then
        REMOVED=1
        continue
      fi
      printf '%s\n' "${line}" >> "${TMP}"
    done < "${SOURCE}"
    atomic_install_both "${TMP}"
    if [ "${REMOVED}" = "1" ]; then
      /usr/bin/logger -t shield-ssh-key-mgr -p auth.info "REMOVED fp=${ARG} user=${SVC_USER}"
    fi
    ;;

  list)
    # Match the helper's lookup order: primary, then fallback.
    if [ -s "${AUTH_KEYS_FILE}" ]; then
      cat "${AUTH_KEYS_FILE}"
    elif [ -s "${FALLBACK_KEYS_FILE}" ]; then
      /usr/bin/logger -t shield-ssh-key-mgr -p auth.warning "list: primary empty — serving fallback"
      cat "${FALLBACK_KEYS_FILE}"
    fi
    ;;

  *)
    /usr/bin/logger -t shield-ssh-key-mgr -p auth.warning "REJECTED: unknown action '${ACTION}'"
    echo "shield-ssh-key-mgr: unknown action (use add|remove|list)" >&2
    exit 1
    ;;
esac
