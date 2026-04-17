import { spawn } from 'child_process';
import { writeLog } from './logger.js';
import * as db from '../database.js';
import { getProvider, getProviderModule } from './providerLoader.js';
import { handleUpdate as _handleUpdate } from './acpUpdateHandler.js';
import { generateTitle as _generateTitle } from './acpTitleGenerator.js';
import { applyConfigOptionsChange, normalizeConfigOptions, normalizeRemovedConfigOptionIds } from './configOptions.js';

/**
 * Singleton JSON-RPC client wrapping the ACP child process.
 * All sessions share one long-lived process; if it dies, pending requests
 * are rejected and the process auto-restarts after a cooldown.
 */
class AcpClient {
  constructor() {
    this.acpProcess = null;
    this.isHandshakeComplete = false;
    this.requestId = 1;
    // Maps request IDs to {resolve, reject} — correlates async responses from stdout
    this.pendingRequests = new Map();
    this.io = null;
    this.serverBootId = null;
    this.sessionMetadata = new Map();
    // Captures stream output into a buffer instead of emitting to UI (used by title generation)
    this.statsCaptures = new Map();
    // Drain absorbs leftover chunks after session history replay to avoid flooding the UI
    this.drainingSessions = new Map();
    // Tracks in-flight permission dialogs so we can respond to the correct JSON-RPC id
    this.pendingPermissions = new Map();
    // Cached provider module — loaded once in start() so intercept() can be called
    // synchronously inside the stdout data handler without awaiting getProviderModule()
    this.providerModule = null;

    this.authMethod = 'none';
  }

  setAuthMethod(_method) {
    // No-op for provider-based auth
  }

  init(io, serverBootId) {
    this.io = io;
    this.serverBootId = serverBootId;
    this.start();
  }

  async start() {
    writeLog('Initializing database...');
    await db.initDb();
    writeLog('Database initialized.');

    // Cache the provider module up-front so the synchronous stdout handler can
    // call intercept() without needing to await an async import each time.
    this.providerModule = await getProviderModule();

    writeLog('Starting ACP daemon...');

    const { config } = getProvider();
    const shell = config.command;
    const baseArgs = config.args || ['acp'];
    const agent = null;
    const args = agent ? [...baseArgs, '--agent', agent] : baseArgs;
    writeLog(`[ACP] Spawning: ${shell} ${args.join(' ')}`);

    // Suppress ANSI escape codes — stdout must be clean JSON lines for parsing
    const childEnv = { ...process.env, TERM: 'dumb', CI: 'true', FORCE_COLOR: '0', DEBUG: '1' };

    this.acpProcess = spawn(shell, args, {
      cwd: process.env.DEFAULT_WORKSPACE_CWD || process.env.USERPROFILE || process.cwd(),
      env: childEnv
    });

    let stdoutBuffer = '';

    this.acpProcess.stdout.on('data', (data) => {
      // writeLog(`[ACP RAW] Received ${data.length} bytes`); // Uncomment to debug upstream buffering
      stdoutBuffer += data.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        try {
          const payload = JSON.parse(line);
          const isChunk = payload.method === 'session/update' &&
            ['agent_message_chunk', 'agent_thought_chunk'].includes(payload.params?.update?.sessionUpdate);
          if (!isChunk || process.env.LOG_MESSAGE_CHUNKS !== 'false') {
            writeLog(`[ACP RECV] ${line}`);
          }

          if (payload.id !== undefined && this.pendingRequests.has(payload.id)) {
            const { resolve, reject, method, params } = this.pendingRequests.get(payload.id);
            this.pendingRequests.delete(payload.id);

            if (payload.error) {
              const errorMsg = payload.error.message || JSON.stringify(payload.error);
              writeLog(`[ACP REQ ERR] Request #${payload.id} (${method}) failed: ${errorMsg}`);

              if (errorMsg.toLowerCase().includes('invalid argument')) {
                writeLog(`[ACP DEBUG] Invalid Argument Params: ${JSON.stringify(params).substring(0, 2000)}`);
              }

              reject(payload.error);
            } else {
              resolve(payload.result);
            }
            return; // Response handled, don't proceed to intercept/route
          }

          // Intercept phase: Let the provider mutate or swallow the payload before routing.
          // Uses the cached this.providerModule (loaded in start()) — getProvider() only
          // returns { config, modulePath } and does NOT expose the module's exported functions.
          const processedPayload = this.providerModule.intercept(payload);

          // If interceptor returns null, the message is swallowed/ignored by the provider
          if (!processedPayload) {
            continue;
          }

          if (processedPayload.method === 'session/update' || processedPayload.method === 'session/notification') {
            this.handleUpdate(processedPayload.params.sessionId, processedPayload.params.update);
          } else if (processedPayload.method === 'session/request_permission' && processedPayload.id !== undefined) {
            writeLog(`[ROUTING] Handling request_permission for ID ${processedPayload.id}`);
            this.handleRequestPermission(processedPayload.id, processedPayload.params);
          } else if (processedPayload.method && getProvider().config.protocolPrefix && processedPayload.method.startsWith(getProvider().config.protocolPrefix)) {
            writeLog(`[ROUTING] Handling provider_extension: ${processedPayload.method}`);
            this.handleProviderExtension(processedPayload);
          } else {
            writeLog(`[ROUTING] No route found for method: ${processedPayload.method}`);
          }
        } catch (err) {
          writeLog(`[ACP PARSE ERR] Malformed payload: ${err.message}`);
        }
      }
    });

    this.acpProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      writeLog(`[ACP STDERR] ${text}`);
      if (text.includes('RESOURCE_EXHAUSTED')) {
          this.io.emit('quota_error', { message: 'A model has hit its capacity limit (429).' });
      }
    });

    this.acpProcess.on('exit', (code) => {
      writeLog(`ACP process died with code ${code}. Restarting...`);
      this.isHandshakeComplete = false;
      for (const [_id, { reject }] of this.pendingRequests) {
        reject(new Error('ACP process died unexpectedly'));
      }
      this.pendingRequests.clear();
      setTimeout(() => this.start(), 2000);
    });

    this.performHandshake();
  }

  handleRequestPermission(id, params) {
    writeLog(`[ACP REQUEST PERMISSION] ID: ${id}, Session: ${params.sessionId}`);
    
    this.pendingPermissions.set(params.sessionId, id);

    if (this.io) {
      this.io.to(`session:${params.sessionId}`).emit('permission_request', {
        id,
        sessionId: params.sessionId,
        options: params.options,
        toolCall: params.toolCall
      });
    }
  }

  respondToPermission(id, optionId) {
    // Permission responses reuse the original JSON-RPC request id — ACP correlates by id, not session
    for (const [sessionId, permId] of this.pendingPermissions) {
      if (permId === id) { this.pendingPermissions.delete(sessionId); break; }
    }
    const isCancel = optionId === 'cancel' || optionId === 'reject' || optionId.includes('reject');
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
    writeLog(`[ACP RESPOND PERMISSION] ${json.trim()}`);
    this.acpProcess.stdin.write(json);
  }

  setMode(sessionId, modeId) {
    writeLog(`[ACP] Setting mode for session ${sessionId} to: ${modeId}`);
    return this.sendRequest('session/set_mode', {
      sessionId,
      mode: modeId
    });
  }

  setConfigOption(sessionId, optionId, value) {
    writeLog(`[ACP] Setting config option for session ${sessionId}: ${optionId}=${value}`);
    return this.sendRequest('session/configure', {
      sessionId,
      options: { [optionId]: value }
    });
  }

  handleProviderExtension(payload) {
    writeLog(`[ACP EXT] ${payload.method}`);

    // Capture dynamic config options (like Effort) in metadata so they aren't lost
    // during the "warming up" phase race condition.
    if (payload.method.endsWith('config_options') && payload.params?.sessionId && (payload.params?.options || payload.params?.removeOptionIds)) {
      const { sessionId } = payload.params;
      const incomingOptions = normalizeConfigOptions(payload.params.options);
      const replace = payload.params.replace === true || payload.params.mode === 'replace';
      const removeOptionIds = normalizeRemovedConfigOptionIds(payload.params.removeOptionIds);

      if (incomingOptions.length === 0 && removeOptionIds.length === 0 && !replace) {
        writeLog(`[ACP EXT] Ignoring empty config_options update for ${sessionId}`);
        return;
      }

      const meta = this.sessionMetadata.get(sessionId) || this.sessionMetadata.get('pending-new');
      const hasMetadata = Boolean(meta);
      const mergedOptions = applyConfigOptionsChange(meta?.configOptions, incomingOptions, { replace, removeOptionIds });
      if (meta) {
        meta.configOptions = mergedOptions;
      }

      payload = {
        ...payload,
        params: {
          ...payload.params,
          options: hasMetadata ? mergedOptions : incomingOptions,
          replace: hasMetadata || replace,
          removeOptionIds
        }
      };

      if (typeof db.saveConfigOptions === 'function') {
        db.saveConfigOptions(sessionId, incomingOptions, { replace, removeOptionIds }).catch(err =>
          writeLog(`[DB ERR] Failed to save configOptions from extension: ${err.message}`)
        );
      }
    }

    if (this.io) {
      this.io.emit('provider_extension', {
        method: payload.method,
        params: payload.params
      });
    }
  }

  async performHandshake() {
    try {
      writeLog('Performing ACP handshake...');
      await new Promise(r => setTimeout(r, 2000));
      const { config: providerConfig } = getProvider();
      await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: providerConfig.clientInfo || { name: 'ACP-UI', version: '1.0.0' }
      });

      const providerModule = await getProviderModule();
      await providerModule.performHandshake(this);

      this.isHandshakeComplete = true;
      writeLog(`ACP Daemon Ready (${providerConfig.name}).`);
      this.io.emit('ready', { message: 'Ready to help ⚡', bootId: this.serverBootId });
      this.io.emit('voice_enabled', { enabled: process.env.VOICE_STT_ENABLED === 'true' });
    } catch (err) {
      writeLog(`ACP Handshake Failed: ${JSON.stringify(err)}`);
    }
  }

  /** Sends a JSON-RPC request and returns a promise resolved when the matching id arrives on stdout */
  sendRequest(method, params = {}) {
    const id = this.requestId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    const json = JSON.stringify(payload) + '\n';
    writeLog(`[ACP SEND] ${json.trim()}`);
    this.acpProcess.stdin.write(json);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method, params });
    });
  }

  sendNotification(method, params = {}) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params
    };
    const json = JSON.stringify(payload) + '\n';
    writeLog(`[ACP NOTIFY] ${json.trim()}`);
    this.acpProcess.stdin.write(json);
  }

  beginDraining(sessionId) {
    writeLog(`[ACP DRAIN] Beginning drain phase for session ${sessionId}`);
    if (this.drainingSessions.has(sessionId)) {
      clearTimeout(this.drainingSessions.get(sessionId).timer);
    }
    
    // We don't resolve here, we just set up the state.
    // The actual promise is created in waitForDrainToFinish.
    this.drainingSessions.set(sessionId, {
      timer: null,
      resolve: null,
      chunkCount: 0
    });
  }

  /**
   * Waits for drain to finish using a silence-based heuristic: resolves after
   * silenceMs with no new chunks. Each incoming chunk resets the timer.
   */
  waitForDrainToFinish(sessionId, silenceMs = 1500) {
    return new Promise((resolve) => {
      const state = this.drainingSessions.get(sessionId);
      if (!state) {
        // Not draining, resolve immediately
        resolve();
        return;
      }

      state.resolve = resolve;
      
      const resetTimer = () => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          writeLog(`[ACP DRAIN] Drain complete for session ${sessionId}. Swallowed ${state.chunkCount} chunks.`);
          this.drainingSessions.delete(sessionId);
          if (state.resolve) state.resolve();
        }, silenceMs);
      };

      // Start the initial timer. If no chunks ever arrive, it will resolve after silenceMs.
      resetTimer();
      // Attach the reset function to the state so handleUpdate can call it
      state.resetTimer = resetTimer;
    });
  }

  handleUpdate(sessionId, update) {
    _handleUpdate(this, sessionId, update);
  }

  async generateTitle(sessionId, meta) {
    return _generateTitle(this, sessionId, meta);
  }
}

export default new AcpClient();
