// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Multi-project state for CLI daemon. Keyed by immutable slug (same as STS sub claim).
// Display names local/informational only — never sent in tokens.

import fs from 'fs';
import path from 'path';
import type { StsManager } from '@ellul.ai/shield-proxy';

/** Persisted project identity from .ellul/project.json */
interface ProjectJson {
  projectSlug: string;
  projectName?: string;
  projectId?: string;
  domain?: string;
}

export interface RegisteredProject {
  /** Immutable infrastructure slug (e.g., "sbx-a1b2c3d"). Primary key. */
  projectSlug: string;
  /** Human-readable display name. Informational only — never sent in tokens. */
  projectName: string;
  /** Absolute path to the directory containing .ellul/project.json. */
  directory: string;
  /** Whether the SSE gate stream is currently active. */
  connected: boolean;
  /** Merkle root hash from the last successful file sync, or null if never synced. */
  lastSyncHash: string | null;
  /** Timestamp (ms) of the last successful sync, or 0 if never synced. */
  lastSyncAt: number;
}

export class ProjectRegistry {
  private projects = new Map<string, RegisteredProject>();

  constructor(
    private stsManager: StsManager,
    private proxyPort: number,
  ) {}

  /**
   * Register a project from its directory.
   *
   * Reads .ellul/project.json to discover the project identity, then
   * warms the STS token cache. If STS acquisition fails the project is
   * still registered (connected=false) so it can retry later.
   *
   * Returns the registered project, or null if the directory does not
   * contain a valid .ellul/project.json.
   */
  async registerProject(directory: string): Promise<RegisteredProject | null> {
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

    // Avoid double-registration; update directory if it changed
    const existing = this.projects.get(slug);
    if (existing) {
      existing.directory = path.resolve(directory);
      return existing;
    }

    const project: RegisteredProject = {
      projectSlug: slug,
      projectName: displayName,
      directory: path.resolve(directory),
      connected: false,
      lastSyncHash: null,
      lastSyncAt: 0,
    };

    this.projects.set(slug, project);

    // Warm the STS cache with the slug — fire-and-forget; failure is non-fatal
    try {
      await this.stsManager.acquireToken(slug);
    } catch {
      // Token will be acquired on next request
    }

    return project;
  }

  /** Get a project by slug. Returns null if not registered. */
  getProject(slug: string): RegisteredProject | null {
    return this.projects.get(slug) ?? null;
  }

  /** Get all registered projects (snapshot). */
  getAllProjects(): RegisteredProject[] {
    return [...this.projects.values()];
  }

  /**
   * Get the default project slug.
   *
   * If exactly one project is registered, returns its slug.
   * Otherwise returns null (caller must disambiguate).
   */
  getDefaultProject(): string | null {
    if (this.projects.size === 1) {
      const [slug] = this.projects.keys();
      return slug;
    }
    return null;
  }

  /** Update the sync state after a successful file sync. */
  updateSyncState(slug: string, hash: string): void {
    const project = this.projects.get(slug);
    if (!project) return;
    project.lastSyncHash = hash;
    project.lastSyncAt = Date.now();
  }

  /** Mark a project's SSE gate stream as connected or disconnected. */
  setConnected(slug: string, connected: boolean): void {
    const project = this.projects.get(slug);
    if (!project) return;
    project.connected = connected;
  }

  /** Unregister a project and revoke its STS token. */
  removeProject(slug: string): void {
    this.projects.delete(slug);
    this.stsManager.removeToken(slug);
  }

  /** Dispose all projects and revoke all STS tokens (graceful shutdown). */
  dispose(): void {
    for (const slug of this.projects.keys()) {
      this.stsManager.removeToken(slug);
    }
    this.projects.clear();
  }
}
