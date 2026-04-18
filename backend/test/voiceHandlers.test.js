import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerVoiceHandlers from '../sockets/voiceHandlers.js';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('../voiceService.js', () => ({
  transcribeAudio: vi.fn().mockResolvedValue('Hello world'),
  isSTTEnabled: vi.fn().mockReturnValue(true)
}));

describe('Voice Handlers', () => {
  let mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = new EventEmitter();
  });

  it('should call transcribeAudio and return text', async () => {
    registerVoiceHandlers({}, mockSocket);
    const callback = vi.fn();
    const handler = mockSocket.listeners('process_voice')[0];
    await handler({ audioBuffer: Buffer.from('audio'), sessionId: 'sess-1' }, callback);
    expect(callback).toHaveBeenCalledWith({ text: 'Hello world' });
  });
});
