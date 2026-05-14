/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_MOUNT_STAGE_H
#define ELLUL_NSD_MOUNT_STAGE_H

#include "daemon.h"

extern char *const NSD_ENVP_SAFE[];

struct nsd_mount_stage_input {
    const char *project;
    const char *home;
    const char *svc_user;
    uid_t       svc_uid;
    gid_t       svc_gid;
    const char *shared_projects;
    const char *shared_previews;
    const char *shared_ports;
    bool        byok;
};

struct nsd_mount_stage_result {
    bool        success;
    int         errcode;
    pid_t       anchor_pid;
    char        unit_name[128];
    char        phase_tail[64];
    char        err_tail[256];
};

int nsd_mount_stage_run(const struct nsd_mount_stage_input *in,
                        struct nsd_mount_stage_result *out);

#endif
