// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * get-peercred — Standalone C helper for peer credential retrieval
 *
 * Fallback for environments where the N-API native addon cannot be compiled.
 * Receives a socket file descriptor number as argv[1], outputs JSON to stdout.
 *
 * Usage: get-peercred <fd>
 * Output: {"uid":1000,"gid":1000,"pid":12345}
 * Exit 0 on success, 1 on error.
 *
 * Called by the daemon via execFileSync (no shell).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>

#ifdef __linux__
#include <sys/un.h>
#endif

#ifdef __APPLE__
#include <sys/ucred.h>
#include <sys/un.h>
#ifndef SOL_LOCAL
#define SOL_LOCAL 0
#endif
#endif

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <fd>\n", argv[0]);
    return 1;
  }

  char *endptr;
  long fd_long = strtol(argv[1], &endptr, 10);
  if (*endptr != '\0' || fd_long < 0 || fd_long > 65535) {
    fprintf(stderr, "Invalid file descriptor: %s\n", argv[1]);
    return 1;
  }
  int fd = (int)fd_long;

#ifdef __linux__
  struct ucred cred;
  socklen_t len = sizeof(struct ucred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    fprintf(stderr, "getsockopt(SO_PEERCRED) failed: %s\n", strerror(errno));
    return 1;
  }
  printf("{\"uid\":%d,\"gid\":%d,\"pid\":%d}\n", cred.uid, cred.gid, cred.pid);
  return 0;
#endif

#ifdef __APPLE__
  struct xucred xcred;
  socklen_t len = sizeof(struct xucred);
  memset(&xcred, 0, sizeof(xcred));
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &xcred, &len) != 0) {
    fprintf(stderr, "getsockopt(LOCAL_PEERCRED) failed: %s\n", strerror(errno));
    return 1;
  }

  int uid = (int)xcred.cr_uid;
  int gid = (int)(xcred.cr_ngroups > 0 ? xcred.cr_groups[0] : -1);

  pid_t peer_pid = 0;
  socklen_t pid_len = sizeof(pid_t);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &pid_len) == 0) {
    printf("{\"uid\":%d,\"gid\":%d,\"pid\":%d}\n", uid, gid, (int)peer_pid);
  } else {
    printf("{\"uid\":%d,\"gid\":%d}\n", uid, gid);
  }
  return 0;
#endif

  fprintf(stderr, "Unsupported platform\n");
  return 1;
}
