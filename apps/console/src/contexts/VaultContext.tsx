// SPDX-License-Identifier: MIT
"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export interface VaultScope {
  id: number;
  name: string;
}

export interface VaultContextValue {
  activeProject: string | null;
  activeNoteId: string | null;
  setActiveNote: (noteId: string | null) => void;
  activeScope: VaultScope | null;
  setActiveScope: (scope: VaultScope | null) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  vaultInitialized: boolean;
  setVaultInitialized: (v: boolean) => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

interface VaultProviderProps {
  children: ReactNode;
  activeProject: string | null;
}

export function VaultProvider({ children, activeProject }: VaultProviderProps) {
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<VaultScope | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [vaultInitialized, setVaultInitialized] = useState(false);

  const setActiveNote = useCallback((noteId: string | null) => {
    setActiveNoteId(noteId);
  }, []);

  return (
    <VaultContext.Provider
      value={{
        activeProject,
        activeNoteId,
        setActiveNote,
        activeScope,
        setActiveScope,
        searchQuery,
        setSearchQuery,
        vaultInitialized,
        setVaultInitialized,
      }}
    >
      {children}
    </VaultContext.Provider>
  );
}

export function useVault() {
  const context = useContext(VaultContext);
  if (!context) {
    throw new Error("useVault must be used within VaultProvider");
  }
  return context;
}
