// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getVpsApiUrl } from "@/lib/domains";

// --- Types ---

export interface VaultNote {
  id: string;
  title: string;
  content: string;
  scopeId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultScope {
  id: number;
  name: string;
  createdAt: string;
}

export interface VaultGraphNode {
  id: string;
  title: string;
  scopeId: number | null;
}

export interface VaultGraphEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
}

export interface VaultIndexStatus {
  indexed: boolean;
  noteCount: number;
  lastIndexedAt: string | null;
}

// --- Fetch Helper ---

async function vaultFetch(serverDomain: string, path: string, options?: RequestInit) {
  const url = `${getVpsApiUrl(serverDomain)}${path}`;
  const res = await fetch(url, { ...options, credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// --- Query Hooks ---

export function useVaultNotes(
  serverDomain: string,
  project: string | null,
  options?: { scopeId?: number },
) {
  const scopeParam = options?.scopeId != null ? `?scopeId=${options.scopeId}` : "";
  return useQuery<VaultNote[]>({
    queryKey: ["vault", "notes", project, options?.scopeId ?? null],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/notes${scopeParam}`),
    enabled: !!project && !!serverDomain,
    staleTime: 60_000,
  });
}

export function useVaultNote(
  serverDomain: string,
  project: string | null,
  noteId: string | null,
) {
  return useQuery<VaultNote>({
    queryKey: ["vault", "note", project, noteId],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/notes/${noteId}`),
    enabled: !!project && !!serverDomain && !!noteId,
    staleTime: 60_000,
  });
}

export function useVaultSearch(
  serverDomain: string,
  project: string | null,
  query: string,
) {
  return useQuery<VaultNote[]>({
    queryKey: ["vault", "search", project, query],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/search?q=${encodeURIComponent(query)}`),
    enabled: !!project && !!serverDomain && query.length > 0,
    staleTime: 60_000,
  });
}

export function useVaultGraph(
  serverDomain: string,
  project: string | null,
  options?: { scopeId?: number },
) {
  const scopeParam = options?.scopeId != null ? `?scopeId=${options.scopeId}` : "";
  return useQuery<VaultGraph>({
    queryKey: ["vault", "graph", project, options?.scopeId ?? null],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/graph${scopeParam}`),
    enabled: !!project && !!serverDomain,
    staleTime: 60_000,
  });
}

export function useVaultBacklinks(
  serverDomain: string,
  project: string | null,
  noteId: string | null,
) {
  return useQuery<VaultNote[]>({
    queryKey: ["vault", "backlinks", project, noteId],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/backlinks/${noteId}`),
    enabled: !!project && !!serverDomain && !!noteId,
    staleTime: 60_000,
  });
}

export function useVaultScopes(
  serverDomain: string,
  project: string | null,
) {
  return useQuery<VaultScope[]>({
    queryKey: ["vault", "scopes", project],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/scopes`),
    enabled: !!project && !!serverDomain,
    staleTime: 60_000,
  });
}

export function useVaultIndexStatus(
  serverDomain: string,
  project: string | null,
) {
  return useQuery<VaultIndexStatus>({
    queryKey: ["vault", "index-status", project],
    queryFn: () =>
      vaultFetch(serverDomain, `/_auth/vault/index/status`),
    enabled: !!project && !!serverDomain,
    staleTime: 60_000,
  });
}

// --- Mutation Hooks ---

export function useVaultInit(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (project: string) =>
      vaultFetch(serverDomain, `/_auth/vault/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
      }),
    onSuccess: (_data, project) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "index-status", project] });
    },
  });
}

export function useVaultCreateNote(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; title: string; content: string; scopeId?: number }) =>
      vaultFetch(serverDomain, `/_auth/vault/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "graph", params.project] });
    },
  });
}

export function useVaultUpdateNote(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; noteId: string; title?: string; content?: string; scopeId?: number | null }) => {
      const { project, noteId, ...body } = params;
      return vaultFetch(serverDomain, `/_auth/vault/notes/${noteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "note", params.project, params.noteId] });
      queryClient.invalidateQueries({ queryKey: ["vault", "graph", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "backlinks", params.project] });
    },
  });
}

export function useVaultDeleteNote(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; noteId: string }) =>
      vaultFetch(serverDomain, `/_auth/vault/notes/${params.noteId}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "note", params.project, params.noteId] });
      queryClient.invalidateQueries({ queryKey: ["vault", "graph", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "backlinks", params.project] });
    },
  });
}

export function useVaultRenameNote(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; noteId: string; title: string }) =>
      vaultFetch(serverDomain, `/_auth/vault/notes/${params.noteId}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: params.title }),
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "note", params.project, params.noteId] });
      queryClient.invalidateQueries({ queryKey: ["vault", "graph", params.project] });
    },
  });
}

export function useVaultRebuildIndex(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (project: string) =>
      vaultFetch(serverDomain, `/_auth/vault/index/rebuild`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
      }),
    onSuccess: (_data, project) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "index-status", project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "search", project] });
    },
  });
}

export function useVaultCreateScope(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; name: string }) =>
      vaultFetch(serverDomain, `/_auth/vault/scopes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: params.name }),
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "scopes", params.project] });
    },
  });
}

export function useVaultUpdateScope(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; scopeId: number; name: string }) =>
      vaultFetch(serverDomain, `/_auth/vault/scopes/${params.scopeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: params.name }),
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "scopes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", params.project] });
    },
  });
}

export function useVaultDeleteScope(serverDomain: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { project: string; scopeId: number }) =>
      vaultFetch(serverDomain, `/_auth/vault/scopes/${params.scopeId}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ["vault", "scopes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "notes", params.project] });
      queryClient.invalidateQueries({ queryKey: ["vault", "graph", params.project] });
    },
  });
}
