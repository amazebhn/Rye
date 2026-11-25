import { createContext, useContext } from "react";

/** Opens the chat's Artifacts panel on one item. Null outside a chat (nothing to open it in). */
export interface ArtifactsPanelControl {
  openFile: (id: string, version?: number) => void;
  openResult: (id: string) => void;
}

export const ArtifactsPanelContext = createContext<ArtifactsPanelControl | null>(null);

export function useArtifactsPanel(): ArtifactsPanelControl | null {
  return useContext(ArtifactsPanelContext);
}
