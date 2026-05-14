// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Local Project Registry — Standalone project state management
 *
 * Manages registered projects for the local daemon without any VPS/STS
 * dependencies. Projects are bound by canonical path + slug fingerprint.
 *
 * Key differences from the VPS ProjectRegistry:
 *   - No StsManager dependency (local STS tokens managed by daemon)
 *   - Canonical path resolution via fs.realpathSync (follows symlinks)
 *   - Workspace fingerprint tracked per project
 *   - Rebind requires explicit call (changing project.json alone doesn't rebind)
 */

import fs from 'fs';
import path from 'path';
import { computeWorkspaceFingerprint } from '../crypto/index';

interface ProjectJson {
  projectSlug: string;
  projectName?: string;
  projectId?: string;
}

export interface LocalRegisteredProject {
  projectSlug: string;
  projectName: string;
  /** Canonical absolute path (symlinks resolved). */
  directory: string;
  /** SHA-256(slug + ":" + canonicalPath). */
  fingerprint: string;
  lastSyncHash: string | null;
  lastSyncAt: number;
}

export class LocalProjectRegistry {
  private projects = new Map<string, LocalRegisteredProject>();

  /**
   * Register a project from its directory.
   *
   * Reads .ellul/project.json, resolves canonical path, computes fingerprint.
   * Returns null if no valid project.json exists.
   */
  async registerProject(directory: string): Promise<LocalRegisteredProject | null> {
    const projectFile = path.join(directory, '.ellul', 'project.json');

    let config: ProjectJson;
    try {
      const raw = fs.readFileSync(projectFile, 'utf8');
      config = JSON.parse(raw) as ProjectJson;
    } catch {
      return null;
    }

    if (!config.projectSlug || typeof config.projectSlug !== 'string') {
      return null;
    }

    const slug = config.projectSlug;
    const displayName = config.projectName || slug;

    // Resolve canonical path (follows symlinks)
    let canonicalDir: string;
    try {
      canonicalDir = fs.realpathSync(path.resolve(directory));
    } catch {
      canonicalDir = path.resolve(directory);
    }

    const fingerprint = computeWorkspaceFingerprint(slug, canonicalDir);

    // Avoid double-registration; update directory if it changed
    const existing = this.projects.get(slug);
    if (existing) {
      // Don't silently rebind — require explicit rebind
      if (existing.directory !== canonicalDir) {
        return existing; // Return existing binding unchanged
      }
      return existing;
    }

    const project: LocalRegisteredProject = {
      projectSlug: slug,
      projectName: displayName,
      directory: canonicalDir,
      fingerprint,
      lastSyncHash: null,
      lastSyncAt: 0,
    };

    this.projects.set(slug, project);
    return project;
  }

  /**
   * Explicit rebind: update the canonical path and fingerprint.
   * Returns the updated project, or null if not registered.
   */
  rebindProject(slug: string, newDirectory: string): LocalRegisteredProject | null {
    const existing = this.projects.get(slug);
    if (!existing) return null;

    let canonicalDir: string;
    try {
      canonicalDir = fs.realpathSync(path.resolve(newDirectory));
    } catch {
      canonicalDir = path.resolve(newDirectory);
    }

    existing.directory = canonicalDir;
    existing.fingerprint = computeWorkspaceFingerprint(slug, canonicalDir);
    return existing;
  }

  getProject(slug: string): LocalRegisteredProject | null {
    return this.projects.get(slug) ?? null;
  }

  getAllProjects(): LocalRegisteredProject[] {
    return [...this.projects.values()];
  }

  getDefaultProject(): string | null {
    if (this.projects.size === 1) {
      const [slug] = this.projects.keys();
      return slug;
    }
    return null;
  }

  updateSyncState(slug: string, hash: string): void {
    const project = this.projects.get(slug);
    if (!project) return;
    project.lastSyncHash = hash;
    project.lastSyncAt = Date.now();
  }

  removeProject(slug: string): void {
    this.projects.delete(slug);
  }

  dispose(): void {
    this.projects.clear();
  }
}
