export class WavRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recordingBuffer: Float32Array[] = [];
  private recordingLength = 0;
  private readonly targetSampleRate = 16000;

  async start(deviceId?: string): Promise<void> {
    this.recordingBuffer = [];
    this.recordingLength = 0;

    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    };

    this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const float32Array = new Float32Array(inputData.length);
      float32Array.set(inputData);
      this.recordingBuffer.push(float32Array);
      this.recordingLength += float32Array.length;
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  async stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (this.processor && this.source) {
        this.source.disconnect();
        this.processor.disconnect();
      }

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((track) => track.stop());
      }

      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().then(() => {
          resolve(this.createWavBlob());
        });
      } else {
        resolve(this.createWavBlob());
      }
    });
  }

  private createWavBlob(): Blob {
    if (this.recordingLength === 0) {
      return new Blob([], { type: 'audio/wav' });
    }

    const inputSampleRate = this.audioContext?.sampleRate || 44100;
    
    // Flatten buffer
    const result = new Float32Array(this.recordingLength);
    let offset = 0;
    for (let i = 0; i < this.recordingBuffer.length; i++) {
      result.set(this.recordingBuffer[i], offset);
      offset += this.recordingBuffer[i].length;
    }

    // Downsample
    const downsampled = this.downsample(result, inputSampleRate, this.targetSampleRate);
    
    // Encode to WAV
    const dataview = this.encodeWAV(downsampled, this.targetSampleRate);
    return new Blob([dataview.buffer as ArrayBuffer], { type: 'audio/wav' });
  }

  private downsample(buffer: Float32Array, sampleRate: number, targetSampleRate: number): Float32Array {
    if (sampleRate === targetSampleRate) {
      return buffer;
    }
    const ratio = sampleRate / targetSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0, count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  private encodeWAV(samples: Float32Array, sampleRate: number): DataView {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (view: DataView, offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, 1, true); // NumChannels (1 for Mono)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate
    view.setUint16(32, 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true); // Subchunk2Size

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return view;
  }
}
