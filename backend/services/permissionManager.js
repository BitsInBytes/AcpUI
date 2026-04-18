import { writeLog } from './logger.js';

export class PermissionManager {
  constructor() {
    this.pendingPermissions = new Map();
  }

  handleRequest(id, params, io, providerId) {
    const { sessionId } = params;
    this.pendingPermissions.set(sessionId, id);
    writeLog(`[PERM] Requesting permission ${id} for session ${sessionId}`);
    
    if (io) {
      io.to('session:' + sessionId).emit('permission_request', {
        id,
        providerId,
        sessionId,
        ...params
      });
    }
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
        break;
      }
    }
  }

  reset() {
    this.pendingPermissions.clear();
  }
}
