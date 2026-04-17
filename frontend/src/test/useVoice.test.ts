import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoice } from '../hooks/useVoice';
import { useVoiceStore } from '../store/useVoiceStore';

// Mock WavRecorder
vi.mock('../utils/wavRecorder', () => ({
  WavRecorder: vi.fn().mockImplementation(function() {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(new Blob([], { type: 'audio/wav' }))
    };
  })
}));

describe('useVoice Hook', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { emit: vi.fn() };
    
    act(() => {
      useVoiceStore.setState({
        isRecording: false,
        isProcessingVoice: false,
        availableAudioDevices: [],
        selectedAudioDevice: '',
      });
    });

    (navigator as any).mediaDevices = {
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'mic1', label: 'Mic 1' }
      ])
    };
  });

  it('fetchAudioDevices updates store', async () => {
    const { result } = renderHook(() => useVoice(mockSocket));
    
    await act(async () => {
      await result.current.fetchAudioDevices();
    });

    expect(useVoiceStore.getState().availableAudioDevices.length).toBe(1);
    expect(useVoiceStore.getState().selectedAudioDevice).toBe('mic1');
  });

  it('startRecording calls WavRecorder.start and updates state', async () => {
    const { result } = renderHook(() => useVoice(mockSocket));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(useVoiceStore.getState().isRecording).toBe(true);
    expect(result.current.recorderRef.current).not.toBeNull();
    expect(result.current.recorderRef.current!.start).toHaveBeenCalled();
  });

  it('stopRecording processes voice if duration is sufficient', async () => {
    const { result } = renderHook(() => useVoice(mockSocket));
    const callback = vi.fn();

    await act(async () => {
      await result.current.startRecording();
    });

    // Fast-forward time so duration is > 400ms
    vi.useFakeTimers();
    vi.advanceTimersByTime(500);

    await act(async () => {
      await result.current.stopRecording(callback);
    });

    // Mock socket callback for process_voice
    const socketCall = mockSocket.emit.mock.calls.find((c: any) => c[0] === 'process_voice');
    if (socketCall) {
      socketCall[2]({ text: 'Transcribed text' });
    }

    expect(useVoiceStore.getState().isRecording).toBe(false);
    vi.useRealTimers();
  });

  it('stopRecording calls WavRecorder.stop and emits process_voice', async () => {
    // Mock Date.now to control duration check
    const realDateNow = Date.now;
    let now = 1000;
    Date.now = () => now;

    const { result } = renderHook(() => useVoice(mockSocket));

    // Start recording (sets voiceStartTimeRef to now=1000)
    await act(async () => {
      await result.current.startRecording();
    });

    const recorder = result.current.recorderRef.current!;

    // Advance time past 400ms threshold
    now = 1500;

    // Mock FileReader to synchronously trigger onload
    const origFileReader = window.FileReader;
    (window as any).FileReader = class {
      result = new ArrayBuffer(8);
      onload: any = null;
      readAsArrayBuffer() {
        if (this.onload) this.onload({ target: this });
      }
    };

    await act(async () => {
      await result.current.stopRecording(vi.fn());
    });

    expect(recorder.stop).toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith('process_voice', expect.any(Object), expect.any(Function));

    Date.now = realDateNow;
    (window as any).FileReader = origFileReader;
  });
});
