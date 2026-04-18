import { spawn } from 'child_process';
import { writeLog } from './logger.js';
import * as db from '../database.js';
import { getProvider, getProviderModule, runWithProvider } from './providerLoader.js';
import { resolveProviderId } from './providerRegistry.js';
import { handleUpdate as _handleUpdate } from './acpUpdateHandler.js';
import { generateTitle as _generateTitle } from './acpTitleGenerator.js';
import { autoLoadPinnedSessions } from './sessionManager.js';
import { applyConfigOptionsChange, normalizeConfigOptions, normalizeRemovedConfigOptionIds } from './configOptions.js';
import { extractModelState, mergeModelOptions } from './modelOptions.js';
import { rememberProviderStatusExtension } from './providerStatusMemory.js';
import { JsonRpcTransport } from './jsonRpcTransport.js';
import { PermissionManager } from './permissionManager.js';
import { StreamController } from './streamController.js';

function withProviderContext(providerId, fn) {
  try {
    return typeof runWithProvider === 'function' ? runWithProvider(providerId, fn) : fn();
  } catch (err) {
    if (process.env.VITEST) return fn();
    throw err;
  }
}

/**
 * Singleton JSON-RPC client wrapping the ACP child process.
 * All sessions share one long-lived process; if it dies, pending requests
 * are rejected and the process auto-restarts after a cooldown.
 */
export class AcpClient {
  constructor(providerId = null) {
    this.providerId = providerId;
    this.acpProcess = null;
    this.isHandshakeComplete = false;
    this.io = null;
    this.serverBootId = null;
    this.sessionMetadata = new Map();
    // Cached provider module — loaded once in start() so intercept() can be called
    // synchronously inside the stdout data handler without awaiting getProviderModule()
    this.providerModule = null;
    this.startPromise = null;

    this.authMethod = 'none';
    this.restartAttempts = 0;
    this.lastRestartTime = 0;
    this.handshakePromise = null;

    this.transport = new JsonRpcTransport();
    this.permissions = new PermissionManager();
    this.stream = new StreamController();
  }

  setProviderId(providerId) {
    if (this.acpProcess && this.providerId && this.providerId !== providerId) {
      throw new Error(`Cannot change provider id for running ACP client from ${this.providerId} to ${providerId}`);
    }
    this.providerId = providerId;
  }

  getProviderId() {
    if (!this.providerId) {
      try {
        this.providerId = resolveProviderId();
      } catch (err) {
        if (process.env.VITEST) {
          this.providerId = 'provider-a';
        } else {
          throw err;
        }
      }
    }
    return this.providerId;
  }

  setAuthMethod(_method) {
    // No-op for provider-based auth
  }

  init(io, serverBootId) {
    this.io = io;
    this.serverBootId = serverBootId;
    return this.start();
  }

  async start() {
    if (this.acpProcess?.exitCode === null) {
      writeLog(`[${this.getProviderId()}] ACP daemon already running; skipping duplicate start`);
      return;
    }
    if (this.startPromise) return this.startPromise;

    const providerId = this.getProviderId();
    this.startPromise = withProviderContext(providerId, async () => {
      writeLog(`[${providerId}] Initializing database...`);
      await db.initDb();
      writeLog(`[${providerId}] Database initialized.`);

      // Cache the provider module up-front so the synchronous stdout handler can
      // call intercept() without needing to await an async import each time.
      this.providerModule = await getProviderModule(providerId);

      writeLog(`[${providerId}] Starting ACP daemon...`);

      const { config } = getProvider(providerId);
      const shell = config.command;
      const baseArgs = config.args || ['acp'];
      const agent = null;
      const args = agent ? [...baseArgs, '--agent', agent] : baseArgs;
      writeLog(`[ACP] Spawning: ${shell} ${args.join(' ')}`);

      // Suppress ANSI escape codes — stdout must be clean JSON lines for parsing
      let childEnv = { ...process.env, TERM: 'dumb', CI: 'true', FORCE_COLOR: '0', DEBUG: '1' };
      if (typeof this.providerModule.prepareAcpEnvironment === 'function') {
        childEnv = await this.providerModule.prepareAcpEnvironment(childEnv, {
          providerConfig: config,
          io: this.io,
          writeLog,
          emitProviderExtension: (method, params) => this.handleProviderExtension({ providerId, method, params })
        }) || childEnv;
      }

      this.acpProcess = spawn(shell, args, {
        cwd: process.env.DEFAULT_WORKSPACE_CWD || process.env.USERPROFILE || process.cwd(),
        env: childEnv,
        shell: process.platform === 'win32'
      });

      if (!this.acpProcess) {
        writeLog(`[${providerId}] Failed to spawn ACP daemon`);
        this.startPromise = null;
        return;
      }

      this.transport.setProcess(this.acpProcess);

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
            this.handleAcpMessage(payload);
          } catch (err) {
            writeLog(`[ACP PARSE ERR] Malformed payload: ${err.message}`);
          }
        }
      });

      this.acpProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        writeLog(`[ACP STDERR] ${text}`);
        if (text.includes('RESOURCE_EXHAUSTED')) {
          this.io.emit('quota_error', { providerId, message: 'A model has hit its capacity limit (429).' });
        }
      });

      this.acpProcess.on('exit', (code) => {
        writeLog(`[${providerId}] ACP daemon exited with code ${code}.`);
        this.isHandshakeComplete = false;
        this.handshakePromise = null;
        this.acpProcess = null;
        this.transport.reset();

        // Exponential back-off for restart (2s, 4s, 8s, 16s, max 30s)
        const now = Date.now();
        if (now - this.lastRestartTime < 60000) {
          this.restartAttempts++;
        } else {
          this.restartAttempts = 1;
        }
        this.lastRestartTime = now;

        const delay = Math.min(Math.pow(2, this.restartAttempts) * 1000, 30000);
        writeLog(`[${providerId}] Restarting ACP daemon in ${delay}ms (Attempt ${this.restartAttempts})...`);
        setTimeout(() => this.start(), delay);
      });

      this.performHandshake();
    });
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async performHandshake() {
    if (this.handshakePromise) return this.handshakePromise;

    const providerId = this.getProviderId();
    this.handshakePromise = withProviderContext(providerId, async () => {
      try {
        writeLog(`[${providerId}] Performing ACP handshake...`);
        await new Promise(r => setTimeout(r, 2000));
        const { config: providerConfig } = getProvider(providerId);
        const providerModule = await getProviderModule(providerId);
        await providerModule.performHandshake(this);

        this.isHandshakeComplete = true;
        writeLog(`ACP Daemon Ready (${providerConfig.name}).`);
        this.io.emit('ready', { providerId, message: 'Ready to help ⚡', bootId: this.serverBootId });
        this.io.emit('voice_enabled', { enabled: process.env.VOICE_STT_ENABLED === 'true' });

        // Auto-load pinned chats into memory so they are hot and ready
        autoLoadPinnedSessions(this).catch(err =>
          writeLog(`[SESSION ERR] Background auto-load failed: ${err.message}`)
        );
      } catch (err) {
        writeLog(`[${providerId}] ACP Handshake Failed: ${err.message || String(err)}`);
        if (err.stack) writeLog(err.stack);
        this.handshakePromise = null; // Allow retry
      }
    });
    return this.handshakePromise;
  }

  handleAcpMessage(payload) {
    // Intercept phase: let the provider mutate or swallow the payload before routing.
    // Uses the cached this.providerModule (loaded in start()) — getProvider() only
    // returns { config, modulePath } and does NOT expose the module's exported functions.
    const processedPayload = this.providerModule?.intercept ? this.providerModule.intercept(payload) : payload;

    // If interceptor returns null, the message is swallowed/ignored by the provider
    if (!processedPayload) return;

    if (processedPayload.method === 'session/update' || processedPayload.method === 'session/notification') {
      this.handleUpdate(processedPayload.params.sessionId, processedPayload.params.update);
    } else if (processedPayload.method === 'session/request_permission' && processedPayload.id !== undefined) {
      writeLog(`[ROUTING] Handling request_permission for ID ${processedPayload.id}`);
      this.handleRequestPermission(processedPayload.id, processedPayload.params);
    } else if (processedPayload.id !== undefined && this.transport.pendingRequests.has(processedPayload.id)) {
      const { resolve, reject, method, params } = this.transport.pendingRequests.get(processedPayload.id);
      this.transport.pendingRequests.delete(processedPayload.id);
      if (processedPayload.error) {
        const errorMsg = processedPayload.error.message || JSON.stringify(processedPayload.error);
        writeLog(`[ACP REQ ERR] Request #${processedPayload.id} (${method}) failed: ${errorMsg}`);
        if (errorMsg.toLowerCase().includes('invalid argument')) {
          writeLog(`[ACP DEBUG] Invalid Argument Params: ${JSON.stringify(params).substring(0, 2000)}`);
        }
        reject(processedPayload.error);
      } else {
        resolve(processedPayload.result);
      }
    } else if (processedPayload.method && getProvider(this.getProviderId()).config.protocolPrefix && processedPayload.method.startsWith(getProvider(this.getProviderId()).config.protocolPrefix)) {
      writeLog(`[ROUTING] Handling provider_extension: ${processedPayload.method}`);
      this.handleProviderExtension(processedPayload);
    } else if (processedPayload.method) {
      writeLog(`[ROUTING] No route found for method: ${processedPayload.method}`);
    }
  }

  handleUpdate(sessionId, update) {
    _handleUpdate(this, sessionId, update);
  }

  handleRequestPermission(id, params) {
    this.permissions.handleRequest(id, params, this.io, this.getProviderId());
  }

  setMode(sessionId, modeId) {
    writeLog(`[ACP] Setting mode for session ${sessionId} to: ${modeId}`);
    return this.transport.sendRequest('session/set_mode', {
      sessionId,
      modeId
    });
  }

  setConfigOption(sessionId, optionId, value) {
    writeLog(`[ACP] Setting config option for session ${sessionId}: ${optionId}=${value}`);
    return this.transport.sendRequest('session/configure', {
      sessionId,
      options: { [optionId]: value }
    });
  }

  handleProviderExtension(payload) {
    const providerId = this.getProviderId();
    writeLog(`[ACP EXT] ${payload.method}`);

    if (payload.params?.sessionId && (payload.params.currentModelId || payload.params.models || payload.params.modelOptions)) {
      this.handleModelStateUpdate(payload.params.sessionId, {
        currentModelId: payload.params.currentModelId,
        models: payload.params.models,
        modelOptions: payload.params.modelOptions
      });
    }

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
        db.saveConfigOptions(providerId, sessionId, incomingOptions, { replace, removeOptionIds }).catch(err =>
          writeLog(`[DB ERR] Failed to save configOptions from extension: ${err.message}`)
        );
      }
    }

    if (this.io) {
      rememberProviderStatusExtension(payload, providerId);
      const params = payload.params || {};
      this.io.emit('provider_extension', {
        providerId,
        method: payload.method,
        params: { ...params, providerId }
      });
    }
  }

  handleModelStateUpdate(sessionId, source = {}) {
    const providerId = this.getProviderId();
    const { models: providerModels } = getProvider(providerId).config;
    const modelState = extractModelState(source, providerModels);
    if (!modelState.currentModelId && modelState.modelOptions.length === 0) return;

    const meta = this.sessionMetadata.get(sessionId) || this.sessionMetadata.get('pending-new');
    const mergedModelOptions = mergeModelOptions(meta?.modelOptions, modelState.modelOptions);
    const currentModelId = modelState.currentModelId || meta?.currentModelId || meta?.model || null;

    if (meta) {
      meta.modelOptions = mergedModelOptions;
      if (currentModelId) {
        meta.currentModelId = currentModelId;
        meta.model = currentModelId;
      }
    }

    if (typeof db.saveModelState === 'function') {
      db.saveModelState(providerId, sessionId, {
        currentModelId,
        modelOptions: mergedModelOptions
      }).catch(err =>
        writeLog(`[DB ERR] Failed to save model state for ${sessionId}: ${err.message}`)
      );
    }

    if (this.io) {
      this.io.emit('session_model_options', {
        providerId,
        sessionId,
        currentModelId,
        modelOptions: mergedModelOptions
      });
    }
  }

  async generateTitle(sessionId, meta) {
    return _generateTitle(this, sessionId, meta);
  }

  resetForTesting() {
    if (this.acpProcess) {
      try { this.acpProcess.kill(); } catch (_e) {}
      this.acpProcess = null;
    }
    this.pendingRequests?.clear();
    this.requestIdCounter = 0;
    this.isHandshakeComplete = false;
    this.handshakePromise = null;
    this.reset();
  }

  reset() {
    this.restartAttempts = 0;
    this.lastRestartTime = 0;
    this.startPromise = null;
    this.handshakePromise = null;
    this.isHandshakeComplete = false;
    this.sessionMetadata.clear();
    this.transport.reset();
    this.permissions.reset();
    this.stream.reset();
  }
}

export default new AcpClient();
