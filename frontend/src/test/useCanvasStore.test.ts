import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCanvasStore } from '../store/useCanvasStore';
import { act } from 'react-dom/test-utils';

describe('useCanvasStore', () => {
  beforeEach(() => {
    act(() => {
      useCanvasStore.setState({
        isCanvasOpen: false,
        canvasOpenBySession: {},
        terminals: [],
        activeTerminalId: null,
        canvasArtifacts: [],
        activeCanvasArtifact: null
      });
    });
  });

  it('setIsCanvasOpen updates global open state', () => {
    act(() => {
      useCanvasStore.getState().setIsCanvasOpen(true);
    });
    expect(useCanvasStore.getState().isCanvasOpen).toBe(true);
  });

  it('setActiveCanvasArtifact updates current artifact', () => {
    const art = { title: 'T1' } as any;
    act(() => {
      useCanvasStore.getState().setActiveCanvasArtifact(art);
    });
    expect(useCanvasStore.getState().activeCanvasArtifact).toEqual(art);
  });

  it('openTerminal adds a terminal and sets it as active', () => {
    act(() => {
      useCanvasStore.getState().openTerminal('s1');
    });
    const state = useCanvasStore.getState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].sessionId).toBe('s1');
    expect(state.activeTerminalId).toBe(state.terminals[0].id);
    expect(state.isCanvasOpen).toBe(true);
  });

  it('closeTerminal handles termination and active switch', () => {
    // Mock Date.now to ensure unique IDs
    let now = 1000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now++);

    act(() => {
        useCanvasStore.getState().openTerminal('s1');
        useCanvasStore.getState().openTerminal('s1');
    });
    const stateBefore = useCanvasStore.getState();
    const term1 = stateBefore.terminals[0];
    const term2 = stateBefore.terminals[1];

    act(() => {
        useCanvasStore.getState().closeTerminal(term2.id);
    });
    const stateAfter = useCanvasStore.getState();
    expect(stateAfter.terminals).toHaveLength(1);
    expect(stateAfter.activeTerminalId).toBe(term1.id);
    
    dateSpy.mockRestore();
  });

  it('handleOpenInCanvas adds new artifact or updates existing', () => {
    const mockSocket = { emit: vi.fn() } as any;
    const art1 = { id: 'a1', title: 'A1', content: 'c1' } as any;
    
    act(() => {
      useCanvasStore.getState().handleOpenInCanvas(mockSocket, 's1', art1);
    });
    
    expect(useCanvasStore.getState().canvasArtifacts).toHaveLength(1);
    expect(useCanvasStore.getState().isCanvasOpen).toBe(true);
    expect(mockSocket.emit).toHaveBeenCalledWith('canvas_save', expect.objectContaining({ id: 'a1', sessionId: 's1' }));

    const art1Updated = { id: 'a1', title: 'A1-v2', content: 'c1-v2' } as any;
    act(() => {
        useCanvasStore.getState().handleOpenInCanvas(mockSocket, 's1', art1Updated);
    });
    expect(useCanvasStore.getState().canvasArtifacts[0].title).toBe('A1-v2');
  });

  it('handleOpenFileInCanvas fetches from socket', () => {
    const mockSocket = {
      emit: vi.fn((event, _params, cb) => {
        if (event === 'canvas_read_file') cb({ artifact: { id: 'f1', title: 'File' } });
      })
    } as any;

    act(() => {
      useCanvasStore.getState().handleOpenFileInCanvas(mockSocket, 's1', 'test.txt');
    });

    expect(useCanvasStore.getState().canvasArtifacts[0].id).toBe('f1');
  });

  it('handleFileEdited updates watched artifacts', () => {
    const mockSocket = {
      emit: vi.fn((event, _params, cb) => {
        if (event === 'canvas_read_file') cb({ artifact: { id: 'a1', content: 'new content' } });
      })
    } as any;

    act(() => {
      useCanvasStore.setState({ 
          canvasArtifacts: [{ id: 'a1', filePath: '/src/main.ts', content: 'old' } as any],
          activeCanvasArtifact: { id: 'a1' } as any
      });
      useCanvasStore.getState().handleFileEdited(mockSocket, 'main.ts');
    });

    expect(useCanvasStore.getState().canvasArtifacts[0].content).toBe('new content');
  });

  it('handleCloseArtifact emits canvas_delete and updates state', () => {
    const mockSocket = { emit: vi.fn() } as any;
    const art = { id: 'a1', title: 'A1' } as any;
    act(() => {
        useCanvasStore.setState({ canvasArtifacts: [art], isCanvasOpen: true, activeCanvasArtifact: art });
        useCanvasStore.getState().handleCloseArtifact(mockSocket, 'a1');
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('canvas_delete', { artifactId: 'a1' });
    expect(useCanvasStore.getState().canvasArtifacts).toHaveLength(0);
    expect(useCanvasStore.getState().isCanvasOpen).toBe(false);
  });

  it('resetCanvas clears artifacts and closes canvas', () => {
    act(() => {
      useCanvasStore.setState({ isCanvasOpen: true, canvasArtifacts: [{} as any] });
      useCanvasStore.getState().resetCanvas();
    });
    expect(useCanvasStore.getState().isCanvasOpen).toBe(false);
    expect(useCanvasStore.getState().canvasArtifacts).toHaveLength(0);
  });
});
