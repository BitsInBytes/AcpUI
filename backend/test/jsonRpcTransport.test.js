import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonRpcTransport } from '../services/jsonRpcTransport.js';

describe('JsonRpcTransport', () => {
  let transport;
  let mockProcess;

  beforeEach(() => {
    transport = new JsonRpcTransport();
    mockProcess = {
      stdin: {
        write: vi.fn()
      }
    };
    transport.setProcess(mockProcess);
  });

  describe('Request/Response Correlation', () => {
    it('should increment request ID and correlate response', async () => {
      const p1 = transport.sendRequest('method1', { a: 1 });
      const p2 = transport.sendRequest('method2', { b: 2 });

      expect(mockProcess.stdin.write).toHaveBeenCalledTimes(2);
      
      const payload1 = JSON.parse(mockProcess.stdin.write.mock.calls[0][0]);
      const payload2 = JSON.parse(mockProcess.stdin.write.mock.calls[1][0]);
      
      expect(payload1.id).toBe(1);
      expect(payload2.id).toBe(2);

      // Simulate responses (out of order)
      const res2 = { jsonrpc: '2.0', id: 2, result: 'res2' };
      const res1 = { jsonrpc: '2.0', id: 1, result: 'res1' };

      // Usually handleAcpMessage (part of AcpClient) would do this, 
      // but we test the correlation map directly here.
      const pending1 = transport.pendingRequests.get(1);
      const pending2 = transport.pendingRequests.get(2);
      
      pending2.resolve(res2.result);
      pending1.resolve(res1.result);

      await expect(p1).resolves.toBe('res1');
      await expect(p2).resolves.toBe('res2');
    });

    it('should reject if process is missing', async () => {
      transport.setProcess(null);
      await expect(transport.sendRequest('any')).rejects.toThrow('ACP process not started');
    });

    it('should reject all pending requests on reset', async () => {
      const p1 = transport.sendRequest('m1');
      const p2 = transport.sendRequest('m2');

      transport.reset();

      await expect(p1).rejects.toThrow('ACP process died unexpectedly');
      await expect(p2).rejects.toThrow('ACP process died unexpectedly');
      expect(transport.pendingRequests.size).toBe(0);
    });

    it('should handle JSON-RPC error responses', async () => {
       const p1 = transport.sendRequest('fail_method');
       const pending = transport.pendingRequests.get(1);
       
       pending.reject({ code: -32601, message: 'Method not found' });
       
       await expect(p1).rejects.toEqual(expect.objectContaining({ code: -32601 }));
    });
  });

  describe('Concurrency', () => {
    it('should handle multiple requests and resolve them independently', async () => {
      const promises = [
        transport.sendRequest('req1'),
        transport.sendRequest('req2'),
        transport.sendRequest('req3')
      ];

      // Resolve in reverse order
      transport.pendingRequests.get(3).resolve('res3');
      transport.pendingRequests.get(2).resolve('res2');
      transport.pendingRequests.get(1).resolve('res1');

      const results = await Promise.all(promises);
      expect(results).toEqual(['res1', 'res2', 'res3']);
    });
  });

  describe('Notifications', () => {
    it('should send notifications without tracking ID', () => {
      transport.sendNotification('notify', { foo: 'bar' });
      const payload = JSON.parse(mockProcess.stdin.write.mock.calls[0][0]);
      
      expect(payload.method).toBe('notify');
      expect(payload.id).toBeUndefined();
      expect(transport.pendingRequests.size).toBe(0);
    });
  });
});
