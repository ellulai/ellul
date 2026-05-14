// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * peercred — N-API native addon for Unix domain socket peer credentials
 *
 * Provides getPeerCredentials(fd) which calls:
 *   Linux: getsockopt(fd, SOL_SOCKET, SO_PEERCRED) -> { uid, gid, pid }
 *   macOS: getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED) -> { uid, gid }
 *        + getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID) -> pid
 *
 * Returns null on error (non-UDS socket, permission denied, etc).
 * Used by the ellul daemon for per-connection caller verification.
 */

#include <node_api.h>
#include <sys/socket.h>
#include <string.h>
#include <errno.h>

#ifdef __linux__
#include <sys/un.h>
/* SO_PEERCRED is in linux/socket.h, but glibc exposes it via sys/socket.h */
#endif

#ifdef __APPLE__
#include <sys/ucred.h>
#include <sys/un.h>
/* LOCAL_PEERCRED and LOCAL_PEERPID defined in sys/un.h on macOS */
#ifndef SOL_LOCAL
#define SOL_LOCAL 0
#endif
#endif

static napi_value get_peer_credentials(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  if (argc < 1) {
    napi_throw_error(env, NULL, "getPeerCredentials requires a file descriptor argument");
    return NULL;
  }

  int32_t fd;
  napi_status status = napi_get_value_int32(env, args[0], &fd);
  if (status != napi_ok || fd < 0) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  int uid = -1, gid = -1, pid = -1;

#ifdef __linux__
  struct ucred cred;
  socklen_t len = sizeof(struct ucred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }
  uid = (int)cred.uid;
  gid = (int)cred.gid;
  pid = (int)cred.pid;
#endif

#ifdef __APPLE__
  /* Get UID/GID via LOCAL_PEERCRED */
  struct xucred xcred;
  socklen_t len = sizeof(struct xucred);
  memset(&xcred, 0, sizeof(xcred));
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &xcred, &len) != 0) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }
  uid = (int)xcred.cr_uid;
  gid = (int)(xcred.cr_ngroups > 0 ? xcred.cr_groups[0] : -1);

  /* Get PID via LOCAL_PEERPID (separate call on macOS) */
  pid_t peer_pid = 0;
  socklen_t pid_len = sizeof(pid_t);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &pid_len) == 0) {
    pid = (int)peer_pid;
  }
  /* PID failure is non-fatal — uid/gid is sufficient for security checks */
#endif

  if (uid == -1) {
    /* Unsupported platform */
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  /* Build result object: { uid, gid, pid } */
  napi_value result;
  napi_create_object(env, &result);

  napi_value uid_val, gid_val, pid_val;
  napi_create_int32(env, uid, &uid_val);
  napi_create_int32(env, gid, &gid_val);
  napi_set_named_property(env, result, "uid", uid_val);
  napi_set_named_property(env, result, "gid", gid_val);

  if (pid >= 0) {
    napi_create_int32(env, pid, &pid_val);
    napi_set_named_property(env, result, "pid", pid_val);
  }

  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "getPeerCredentials", NAPI_AUTO_LENGTH,
                       get_peer_credentials, NULL, &fn);
  napi_set_named_property(env, exports, "getPeerCredentials", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
