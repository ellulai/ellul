// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useState, useEffect, useCallback } from "react";
import type { FileNode, GitChange, SearchResult, BlameLine, Commit } from "../types";

// Fetch file tree and git status from file-api.
export function useFileTree(project: string | null) {
  const [tree, setTree] = useState<FileNode | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTree = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);

    try {
      const [treeRes, statusRes] = await Promise.all([
        fetch(`/api/tree?project=${encodeURIComponent(project)}`, { credentials: "include" }),
        fetch(`/api/status?project=${encodeURIComponent(project)}`, { credentials: "include" }),
      ]);

      if (treeRes.status === 401 || statusRes.status === 401) {
        setError("auth_needed");
        return;
      }

      if (!treeRes.ok) throw new Error("Failed to fetch tree");

      const treeData = await treeRes.json();
      setTree(treeData.tree);

      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setChanges(statusData.modified || []);
        setIsRepo(statusData.isRepo === true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  const fetchFile = useCallback(
    async (filePath: string): Promise<string | null> => {
      if (!project) return null;
      try {
        const res = await fetch(
          `/api/file?path=${encodeURIComponent(project + "/" + filePath)}`,
          { credentials: "include" }
        );
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },
    [project]
  );

  // Fetch unified diff for a changed file.
  const fetchDiff = useCallback(
    async (filePath: string, status: string): Promise<string | null> => {
      if (!project) return null;
      try {
        const res = await fetch(
          `/api/diff?path=${encodeURIComponent(filePath)}&project=${encodeURIComponent(project)}&status=${encodeURIComponent(status)}`,
          { credentials: "include" },
        );
        if (res.status === 204) return null; // untracked, no diff
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },
    [project],
  );

  // Search across project files (literal substring, case-insensitive)
  const fetchSearch = useCallback(
    async (query: string, glob?: string): Promise<{ results: SearchResult[]; truncated: boolean } | null> => {
      if (!project || !query.trim()) return null;
      try {
        const params = new URLSearchParams({ q: query, project, limit: '100' });
        if (glob) params.set('glob', glob);
        const res = await fetch(`/api/search?${params}`, { credentials: 'include' });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    [project],
  );

  // Fetch blame annotations for a file
  const fetchBlame = useCallback(
    async (filePath: string): Promise<BlameLine[] | null> => {
      if (!project) return null;
      try {
        const res = await fetch(
          `/api/blame?path=${encodeURIComponent(filePath)}&project=${encodeURIComponent(project)}`,
          { credentials: 'include' },
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.lines;
      } catch {
        return null;
      }
    },
    [project],
  );

  // Fetch commit log for a file (or project if no path)
  const fetchLog = useCallback(
    async (filePath?: string): Promise<Commit[] | null> => {
      if (!project) return null;
      try {
        const params = new URLSearchParams({ project, limit: '20' });
        if (filePath) params.set('path', filePath);
        const res = await fetch(`/api/log?${params}`, { credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json();
        return data.commits;
      } catch {
        return null;
      }
    },
    [project],
  );

  return { tree, changes, isRepo, loading, error, fetchTree, fetchFile, fetchDiff, fetchSearch, fetchBlame, fetchLog, setTree, setChanges };
}
