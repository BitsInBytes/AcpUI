import { writeLog } from './logger.js';
import { persistStreamEvent } from './sessionStreamPersistence.js';

export class PermissionManager {
  constructor() {
    this.pendingPermissions = new Map();
    this.pendingPermissionPayloads = new Map();
  }

  handleRequest(id, params, io, providerId, acpClient = null) {
    const { sessionId } = params;
    const payload = {
      id,
      providerId,
      sessionId,
      ...params
    };
    this.pendingPermissions.set(sessionId, id);
    this.pendingPermissionPayloads.set(sessionId, payload);
    writeLog(`[PERM] Requesting permission ${id} for session ${sessionId}`);

    if (acpClient) {
      void persistStreamEvent(acpClient, sessionId, { type: 'permission_request', ...payload }, { force: true })
        .catch(err => writeLog(`[DB ERR] Failed to persist permission request ${id}: ${err.message}`));
    }

    if (io) {
      io.to('session:' + sessionId).emit('permission_request', payload);
    }
  }

  getPendingPermissionForSession(sessionId, providerId = null) {
    const payload = this.pendingPermissionPayloads.get(sessionId);
    if (!payload) return null;
    if (providerId && payload.providerId && payload.providerId !== providerId) return null;
    return payload;
  }

  async respond(id, optionId, transport) {
    writeLog(`[PERM] Responding to permission ${id} with ${optionId}`);
    
    const isCancel = optionId === 'cancel' || optionId === 'reject' || optionId.includes('reject');
    const _outcome = isCancel ? 'cancelled' : 'approved';
    
    // Standard ACP: Permission responses are JSON-RPC results matching the request ID.
    // The result object MUST contain an 'outcome' property, which itself is an object
    // containing another 'outcome' discriminator (selected/cancelled).
    const payload = {
      jsonrpc: '2.0',
      id,
      result: {
        outcome: isCancel
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId }
      }
    };

    const json = JSON.stringify(payload) + '\n';
    writeLog(`[PERM] Sending response to daemon: ${json.trim()}`);
    if (transport.acpProcess) {
      transport.acpProcess.stdin.write(json);
    }

    // Cleanup
    for (const [sid, pid] of this.pendingPermissions) {
      if (pid === id) {
        this.pendingPermissions.delete(sid);
        this.pendingPermissionPayloads.delete(sid);
        break;
      }
    }
  }

  reset() {
    this.pendingPermissions.clear();
    this.pendingPermissionPayloads.clear();
  }
}
