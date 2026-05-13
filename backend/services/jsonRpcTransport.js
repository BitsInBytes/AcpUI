import { writeLog } from './logger.js';

export class JsonRpcTransport {
  constructor() {
    this.requestId = 1;
    this.pendingRequests = new Map();
    this.acpProcess = null;
  }

  setProcess(acpProcess) {
    this.acpProcess = acpProcess;
  }

  getPendingRequestContext(id) {
    const pending = this.pendingRequests.get(id);
    if (!pending) return null;

    return {
      id,
      method: pending.method,
      sessionId: pending.sessionId,
      params: pending.params
    };
  }

  sendRequest(method, params = {}) {
    const id = this.requestId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const json = JSON.stringify(payload) + '\n';
    writeLog(`[ACP SEND] ${json.trim()}`);

    if (!this.acpProcess) {
      return Promise.reject(new Error('ACP process not started'));
    }

    return new Promise((resolve, reject) => {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
      this.pendingRequests.set(id, { resolve, reject, method, params, sessionId });
      this.acpProcess.stdin.write(json);
    });
  }

  sendNotification(method, params = {}) {
    const payload = { jsonrpc: '2.0', method, params };
    const json = JSON.stringify(payload) + '\n';
    writeLog(`[ACP NOTIFY] ${json.trim()}`);
    if (this.acpProcess) {
      this.acpProcess.stdin.write(json);
    }
  }

  reset() {
    for (const [_id, pending] of this.pendingRequests) {
      pending.reject(new Error('ACP process died unexpectedly'));
    }
    this.pendingRequests.clear();
  }
}
