import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// Hoist Mocks
const { mockLogStream } = vi.hoisted(() => ({
  mockLogStream: { write: vi.fn(), end: vi.fn() }
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => mockLogStream)
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => mockLogStream)
}));

import { writeLog, setIo, broadcastEvent, getLogFilePath } from '../services/logger.js';

describe('Logger Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write a log entry and emit to IO', () => {
    const mockIo = { emit: vi.fn() };
    setIo(mockIo);
    
    writeLog('Test message');

    expect(mockLogStream.write).toHaveBeenCalledWith(expect.stringContaining('Test message'));
    expect(mockIo.emit).toHaveBeenCalledWith('log_update', expect.stringContaining('Test message'));
  });

  it('handles non-string objects via console.log', () => {
      console.log({ foo: 'bar' });
      expect(mockLogStream.write).toHaveBeenCalledWith(expect.stringContaining('"foo": "bar"'));
  });

  it('handles logStream.write errors gracefully', () => {
      mockLogStream.write.mockImplementationOnce(() => { throw new Error('write error'); });
      // Should not throw
      writeLog('Safe message');
  });

  it('redirects console methods', () => {
    console.log('Log');
    console.error('Error');
    console.warn('Warn');
    expect(mockLogStream.write).toHaveBeenCalledTimes(3);
  });

  it('safeStringify handles circular structures', () => {
    const a = {};
    const b = { a };
    a.b = b;
    
    console.log(a);
    expect(mockLogStream.write).toHaveBeenCalledWith(expect.stringContaining('[Unserializable Object'));
  });

  it('writeLog handles recursion with isLogging guard', () => {
    const mockIo = { emit: vi.fn() };
    setIo(mockIo);

    // Mock emit to call writeLog recursively
    mockIo.emit.mockImplementation((event) => {
        if (event === 'log_update') {
            writeLog('Recursive log');
        }
    });

    writeLog('Initial log');
    // If the guard works, it should only call logStream.write twice
    // (Initial log and the recursive attempt that will be blocked)
    // Wait, if blocked, it should ONLY be called ONCE.
    expect(mockLogStream.write).toHaveBeenCalledTimes(1);
  });

  it('broadcastEvent emits event to io when io is set', () => {
    const mockIo = { emit: vi.fn() };
    setIo(mockIo);
    broadcastEvent('my_event', { value: 42 });
    expect(mockIo.emit).toHaveBeenCalledWith('my_event', { value: 42 });
  });

  it('broadcastEvent is a no-op when io is not set', () => {
    setIo(null);
    expect(() => broadcastEvent('my_event', {})).not.toThrow();
  });

  it('getLogFilePath returns a non-empty string', () => {
    const p = getLogFilePath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});
