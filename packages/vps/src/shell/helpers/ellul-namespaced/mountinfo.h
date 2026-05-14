/*
 * ellul-namespaced — /proc/self/mountinfo parser.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_MOUNTINFO_H
#define ELLUL_NSD_MOUNTINFO_H

#include "daemon.h"

#define NSD_MAX_MOUNTINFO_ENTRIES 256
#define NSD_MOUNTINFO_FIELD_LEN   512

/*
 * Per `man 5 proc`, /proc/<pid>/mountinfo lines are space-delimited:
 *   mount_id parent_id major:minor root mount_point options optional...
 *   - separator -
 *   fstype mount_source super_options
 *
 * We parse the fields we care about for attestation.
 */
struct nsd_mountinfo_entry {
    uint32_t mount_id;
    char     mount_point[NSD_MOUNTINFO_FIELD_LEN];
    char     fstype[64];
    char     source[NSD_MOUNTINFO_FIELD_LEN];
    char     options[NSD_MOUNTINFO_FIELD_LEN];        /* per-mount options (field 6) */
    char     super_options[NSD_MOUNTINFO_FIELD_LEN];  /* superblock options (after - fstype) */
};

struct nsd_mountinfo {
    struct nsd_mountinfo_entry *entries;
    size_t                       n_entries;
};

/*
 * Read /proc/self/mountinfo and parse entries. Caller owns the result and
 * must free it with nsd_mountinfo_free().
 */
int nsd_mountinfo_read_self(struct nsd_mountinfo **out);

void nsd_mountinfo_free(struct nsd_mountinfo *mi);

/* Find the entry whose mount_point exactly matches `path`; NULL if none. */
const struct nsd_mountinfo_entry *
nsd_mountinfo_find(const struct nsd_mountinfo *mi, const char *path);

/* Check whether opts string contains substring (treats commas as separators). */
bool nsd_mountinfo_opt_has(const char *opts, const char *needle);

#endif
