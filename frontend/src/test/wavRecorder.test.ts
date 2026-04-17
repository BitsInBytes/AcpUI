import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WavRecorder } from '../utils/wavRecorder';

describe('WavRecorder Utility', () => {
  let recorder: WavRecorder;

  beforeEach(() => {
    recorder = new WavRecorder();

    // Mock Web Audio API
    (window as any).AudioContext = vi.fn().mockImplementation(function() {
      return {
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
        createScriptProcessor: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }),
        destination: {},
        close: vi.fn().mockResolvedValue(undefined),
        sampleRate: 44100
      };
    }) as any;

    (navigator as any).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }]
      })
    };
  });

  it('downsamples buffer correctly', () => {
    const input = new Float32Array([1, 1, -1, -1]);
    const sampleRate = 44100;
    const targetSampleRate = 22050; // Half
    
    // @ts-expect-error - access private for testing
    const output = recorder.downsample(input, sampleRate, targetSampleRate);
    
    expect(output.length).toBe(2);
    expect(output[0]).toBe(1);
    expect(output[1]).toBe(-1);
  });

  it('encodes WAV header correctly', () => {
    const samples = new Float32Array([0, 0.5, -0.5]);
    const sampleRate = 16000;
    
    // @ts-expect-error - access private for testing
    const view = recorder.encodeWAV(samples, sampleRate);
    
    // Check RIFF header
    expect(view.getUint8(0)).toBe('R'.charCodeAt(0));
    expect(view.getUint8(1)).toBe('I'.charCodeAt(0));
    expect(view.getUint8(2)).toBe('F'.charCodeAt(0));
    expect(view.getUint8(3)).toBe('F'.charCodeAt(0));

    // Check SampleRate (at offset 24)
    expect(view.getUint32(24, true)).toBe(16000);

    // Check bits per sample (at offset 34)
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('stops recording and returns a blob', async () => {
    await recorder.start();
    const blob = await recorder.stop();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');
  });
});
