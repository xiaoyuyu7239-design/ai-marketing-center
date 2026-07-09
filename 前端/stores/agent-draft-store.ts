import { create } from "zustand";

interface AgentDraft {
  prompt: string;
  files: File[];
}

interface AgentDraftState {
  draft: AgentDraft | null;
  setDraft: (draft: AgentDraft) => void;
  clearDraft: () => void;
}

export const useAgentDraftStore = create<AgentDraftState>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: null }),
}));
