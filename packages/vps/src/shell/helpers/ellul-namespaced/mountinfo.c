/*
 * ellul-namespaced — /proc/self/mountinfo parser.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "mountinfo.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Decode mountinfo's octal escapes (\040 for space, etc.) in place.
 * Standard Linux mountinfo escape encoding. */
static void unescape_in_place(char *s) {
    char *r = s, *w = s;
    while (*r) {
        if (*r == '\\' && r[1] >= '0' && r[1] <= '3' &&
            r[2] >= '0' && r[2] <= '7' && r[3] >= '0' && r[3] <= '7') {
            int v = (r[1] - '0') * 64 + (r[2] - '0') * 8 + (r[3] - '0');
            *w++ = (char)v;
            r += 4;
        } else {
            *w++ = *r++;
        }
    }
    *w = 0;
}

/* Copy a whitespace-delimited field starting at *cursor into dst (size cap).
 * Advances *cursor past the field and any trailing whitespace.
 * Returns 0 on success, -1 if buffer would overflow or no field present. */
static int copy_field(const char **cursor, char *dst, size_t cap) {
    const char *p = *cursor;
    while (*p == ' ' || *p == '\t') p++;
    if (!*p || *p == '\n') return -1;
    size_t i = 0;
    while (*p && *p != ' ' && *p != '\t' && *p != '\n') {
        if (i + 1 >= cap) return -1;
        dst[i++] = *p++;
    }
    dst[i] = 0;
    *cursor = p;
    return 0;
}

static int parse_one_line(const char *line, struct nsd_mountinfo_entry *e) {
    const char *p = line;
    char field[NSD_MOUNTINFO_FIELD_LEN];

    /* mount_id */
    if (copy_field(&p, field, sizeof(field)) != 0) return -1;
    char *endptr;
    long mid = strtol(field, &endptr, 10);
    if (*endptr || mid < 0) return -1;
    e->mount_id = (uint32_t)mid;

    /* parent_id (skip) */
    if (copy_field(&p, field, sizeof(field)) != 0) return -1;
    /* major:minor (skip) */
    if (copy_field(&p, field, sizeof(field)) != 0) return -1;
    /* root (skip) */
    if (copy_field(&p, field, sizeof(field)) != 0) return -1;

    /* mount_point */
    if (copy_field(&p, e->mount_point, sizeof(e->mount_point)) != 0) return -1;
    unescape_in_place(e->mount_point);

    /* options (per-mount; field 6) */
    if (copy_field(&p, e->options, sizeof(e->options)) != 0) return -1;

    /* Skip optional fields until "-" separator. */
    for (int i = 0; i < 8; i++) {
        if (copy_field(&p, field, sizeof(field)) != 0) return -1;
        if (strcmp(field, "-") == 0) break;
    }

    /* fstype */
    if (copy_field(&p, e->fstype, sizeof(e->fstype)) != 0) return -1;

    /* mount_source */
    if (copy_field(&p, e->source, sizeof(e->source)) != 0) return -1;
    unescape_in_place(e->source);

    /* super_options */
    if (copy_field(&p, e->super_options, sizeof(e->super_options)) != 0) return -1;

    return 0;
}

int nsd_mountinfo_read_self(struct nsd_mountinfo **out) {
    int fd = open("/proc/self/mountinfo", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;

    /* Read all into a heap buffer. */
    size_t cap = 16 * 1024;
    size_t len = 0;
    char *buf = malloc(cap);
    if (!buf) { close(fd); return -1; }
    while (1) {
        if (len + 4096 > cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) { free(buf); close(fd); return -1; }
            buf = nb;
        }
        ssize_t r = read(fd, buf + len, cap - len - 1);
        if (r < 0) {
            if (errno == EINTR) continue;
            free(buf); close(fd); return -1;
        }
        if (r == 0) break;
        len += (size_t)r;
        if (len > 1024 * 1024) {  /* sanity cap */
            free(buf); close(fd); errno = EFBIG; return -1;
        }
    }
    close(fd);
    buf[len] = 0;

    struct nsd_mountinfo *mi = calloc(1, sizeof(*mi));
    if (!mi) { free(buf); return -1; }
    mi->entries = calloc(NSD_MAX_MOUNTINFO_ENTRIES, sizeof(*mi->entries));
    if (!mi->entries) { free(mi); free(buf); return -1; }

    char *line = buf;
    while (line < buf + len) {
        char *eol = strchr(line, '\n');
        if (eol) *eol = 0;
        if (*line && mi->n_entries < NSD_MAX_MOUNTINFO_ENTRIES) {
            if (parse_one_line(line, &mi->entries[mi->n_entries]) == 0) {
                mi->n_entries++;
            }
            /* Lines we can't parse are silently skipped — mountinfo can have
             * future fields we don't understand. */
        }
        if (!eol) break;
        line = eol + 1;
    }
    free(buf);
    *out = mi;
    return 0;
}

void nsd_mountinfo_free(struct nsd_mountinfo *mi) {
    if (!mi) return;
    free(mi->entries);
    free(mi);
}

const struct nsd_mountinfo_entry *
nsd_mountinfo_find(const struct nsd_mountinfo *mi, const char *path) {
    if (!mi || !path) return NULL;
    for (size_t i = 0; i < mi->n_entries; i++) {
        if (strcmp(mi->entries[i].mount_point, path) == 0)
            return &mi->entries[i];
    }
    return NULL;
}

bool nsd_mountinfo_opt_has(const char *opts, const char *needle) {
    if (!opts || !needle) return false;
    size_t nlen = strlen(needle);
    const char *p = opts;
    while (*p) {
        const char *comma = strchr(p, ',');
        size_t span = comma ? (size_t)(comma - p) : strlen(p);
        if (span >= nlen && strncmp(p, needle, nlen) == 0 &&
            (span == nlen || p[nlen] == '=' || p[nlen] == ',')) {
            return true;
        }
        if (!comma) break;
        p = comma + 1;
    }
    return false;
}
