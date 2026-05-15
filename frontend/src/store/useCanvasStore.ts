import { Socket } from 'socket.io-client';
import { create } from 'zustand';
import type { CanvasArtifact, CanvasReadFileRequest, CanvasReadFileResponse } from '../types';

interface CanvasState {
  isCanvasOpen: boolean;
  canvasOpenBySession: Record<string, boolean>;
  terminals: { id: string; label: string; sessionId: string }[];
  activeTerminalId: string | null;
  canvasArtifacts: CanvasArtifact[];
  activeCanvasArtifact: CanvasArtifact | null;
  canvasError: string | null;
  
  // Basic Setters
  setIsCanvasOpen: (isOpen: boolean) => void;
  setCanvasArtifacts: (artifacts: CanvasArtifact[]) => void;
  setActiveCanvasArtifact: (artifact: CanvasArtifact | null) => void;
  setCanvasError: (message: string | null) => void;
  
  // Terminal
  openTerminal: (sessionId: string) => void;
  closeTerminal: (id: string) => void;
  setActiveTerminalId: (id: string | null) => void;
  
  // Complex Actions
  resetCanvas: () => void;
  handleOpenInCanvas: (socket: Socket | null, activeSessionId: string | null, artifact: CanvasArtifact) => void;
  handleOpenFileInCanvas: (socket: Socket | null, activeSessionId: string | null, filePath: string) => void;
  handleFileEdited: (socket: Socket | null, editedFilePath: string) => void;
  handleCloseArtifact: (socket: Socket | null, artifactId: string) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  isCanvasOpen: false,
  canvasOpenBySession: {},
  terminals: [],
  activeTerminalId: null,
  canvasArtifacts: [],
  activeCanvasArtifact: null,
  canvasError: null,

  setIsCanvasOpen: (isOpen) => set({ isCanvasOpen: isOpen }),
  setCanvasArtifacts: (artifacts) => set({ canvasArtifacts: artifacts }),
  setActiveCanvasArtifact: (artifact) => set({ activeCanvasArtifact: artifact }),
  setCanvasError: (message) => set({ canvasError: message }),

  openTerminal: (sessionId) => set(prev => {
    const id = `term-${Date.now()}`;
    const sessionTerminals = prev.terminals.filter(t => t.sessionId === sessionId);
    const num = sessionTerminals.length + 1;
    return { terminals: [...prev.terminals, { id, label: `Terminal ${num}`, sessionId }], activeTerminalId: id, isCanvasOpen: true };
  }),
  closeTerminal: (id) => set(prev => {
    const filtered = prev.terminals.filter(t => t.id !== id);
    const wasActive = prev.activeTerminalId === id;
    return {
      terminals: filtered,
      activeTerminalId: wasActive ? (filtered[0]?.id || null) : prev.activeTerminalId,
      isCanvasOpen: filtered.length > 0 || prev.canvasArtifacts.length > 0,
    };
  }),
  setActiveTerminalId: (id) => set({ activeTerminalId: id }),

  resetCanvas: () => set(prev => ({
    isCanvasOpen: prev.terminals.length > 0,
    activeTerminalId: prev.terminals.length > 0 ? prev.terminals[0].id : null,
    canvasArtifacts: [],
    activeCanvasArtifact: null
  })),

  handleOpenInCanvas: (socket, activeSessionId, artifact) => {
    const state = get();
    const newArtifact = { ...artifact };
    
    if (activeSessionId) {
      newArtifact.sessionId = activeSessionId;
    }

    const existing = state.canvasArtifacts.find(a => 
      (a.filePath && newArtifact.filePath && a.filePath === newArtifact.filePath) || 
      (a.id === newArtifact.id)
    );

    if (existing) {
      const updated = { ...newArtifact, id: existing.id };
      if (socket && newArtifact.sessionId) {
        socket.emit('canvas_save', updated);
      }
      set(prev => ({
        activeCanvasArtifact: updated,
        canvasArtifacts: prev.canvasArtifacts.map(a => a.id === existing.id ? updated : a),
        isCanvasOpen: true,
        canvasError: null
      }));
    } else {
      if (socket && newArtifact.sessionId) {
        socket.emit('canvas_save', newArtifact);
      }
      set(prev => ({
        activeCanvasArtifact: newArtifact,
        canvasArtifacts: [...prev.canvasArtifacts, newArtifact],
        isCanvasOpen: true,
        canvasError: null
      }));
    }
  },

  handleOpenFileInCanvas: (socket, activeSessionId, filePath) => {
    if (!socket || !activeSessionId) return;
    const request: CanvasReadFileRequest = { filePath, sessionId: activeSessionId };
    socket.emit('canvas_read_file', request, (res: CanvasReadFileResponse) => {
      if (res.artifact) {
        get().handleOpenInCanvas(socket, activeSessionId, res.artifact);
      } else if (res.error) {
        set({ canvasError: 'Failed to read file: ' + res.error });
      }
    });
  },

  handleFileEdited: (socket, editedFilePath) => {
    const state = get();
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const editedNormalized = normalize(editedFilePath);
    
    const watched = state.canvasArtifacts.find(a => 
      a.filePath && (normalize(a.filePath).endsWith(editedNormalized) || editedNormalized.endsWith(normalize(a.filePath)))
    );
    
    if (watched && socket && watched.filePath) {
      const request: CanvasReadFileRequest = { filePath: watched.filePath, sessionId: watched.sessionId };
      socket.emit('canvas_read_file', request, (res: CanvasReadFileResponse) => {
        if (res.artifact) {
          const updatedArtifact = { 
            ...res.artifact, 
            id: watched.id,
            sessionId: watched.sessionId,
            lastUpdated: Date.now() 
          };
          
          set(prev => {
            const newArtifacts = prev.canvasArtifacts.map(a => a.id === watched.id ? updatedArtifact : a);
            const newActive = prev.activeCanvasArtifact?.id === watched.id ? updatedArtifact : prev.activeCanvasArtifact;
            return {
              canvasArtifacts: newArtifacts,
              activeCanvasArtifact: newActive
            };
          });
        }
      });
    }
  },

  handleCloseArtifact: (socket, artifactId) => {
    set(prev => {
      const filtered = prev.canvasArtifacts.filter(a => a.id !== artifactId);
      let newIsOpen = prev.isCanvasOpen;
      let newActive = prev.activeCanvasArtifact;

      if (filtered.length === 0) {
        newIsOpen = prev.terminals.length > 0; // keep open if terminal is still active
      }

      if (prev.activeCanvasArtifact?.id === artifactId) {
        newActive = filtered.length > 0 ? filtered[0] : null;
      }

      return {
        canvasArtifacts: filtered,
        isCanvasOpen: newIsOpen,
        activeCanvasArtifact: newActive
      };
    });

    if (socket) {
      socket.emit('canvas_delete', { artifactId });
    }
  }
}));
