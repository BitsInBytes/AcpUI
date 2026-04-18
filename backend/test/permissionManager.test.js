import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionManager } from '../services/permissionManager.js';

describe('PermissionManager', () => {
  let manager;
  let mockIo;
  let mockTransport;

  beforeEach(() => {
    manager = new PermissionManager();
    mockIo = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn()
    };
    mockTransport = {
      acpProcess: {
        stdin: {
          write: vi.fn()
        }
      }
    };
  });

  describe('Permission Requests', () => {
    it('should track requests and emit to correct session room', () => {
      const params = { sessionId: 's1', toolCall: { name: 't1' } };
      manager.handleRequest(42, params, mockIo, 'p1');

      expect(manager.pendingPermissions.get('s1')).toBe(42);
      expect(mockIo.to).toHaveBeenCalledWith('session:s1');
      expect(mockIo.emit).toHaveBeenCalledWith('permission_request', expect.objectContaining({
        id: 42,
        providerId: 'p1'
      }));
    });
  });

  describe('Permission Responses', () => {
    it('should correlate approval and send correct JSON-RPC result', () => {
      manager.pendingPermissions.set('s1', 42);
      manager.respond(42, 'allow', mockTransport);

      const written = mockTransport.acpProcess.stdin.write.mock.calls[0][0];
      const payload = JSON.parse(written);

      expect(payload.id).toBe(42);
      expect(payload.result.outcome.outcome).toBe('selected');
      expect(payload.result.outcome.optionId).toBe('allow');
      expect(manager.pendingPermissions.has('s1')).toBe(false);
    });

    it('should correlate rejection and send cancelled outcome', () => {
      manager.pendingPermissions.set('s1', 42);
      manager.respond(42, 'reject', mockTransport);

      const written = mockTransport.acpProcess.stdin.write.mock.calls[0][0];
      const payload = JSON.parse(written);

      expect(payload.result.outcome.outcome).toBe('cancelled');
      expect(manager.pendingPermissions.has('s1')).toBe(false);
    });

    it('should handle missing acpProcess gracefully', async () => {
      const mockTransportNoProc = { acpProcess: null };
      manager.pendingPermissions.set('s1', 42);
      await manager.respond(42, 'allow', mockTransportNoProc);
      expect(manager.pendingPermissions.has('s1')).toBe(false);
    });

    it('should support out-of-order responses across sessions', () => {
      manager.pendingPermissions.set('s1', 101);
      manager.pendingPermissions.set('s2', 102);

      // Respond to second first
      manager.respond(102, 'allow', mockTransport);
      expect(manager.pendingPermissions.has('s2')).toBe(false);
      expect(manager.pendingPermissions.get('s1')).toBe(101);

      manager.respond(101, 'allow', mockTransport);
      expect(manager.pendingPermissions.has('s1')).toBe(false);
    });
  });

  describe('Lifecycle', () => {
    it('should clear state on reset', () => {
      manager.pendingPermissions.set('s1', 1);
      manager.reset();
      expect(manager.pendingPermissions.size).toBe(0);
    });
  });
});
