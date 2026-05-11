import * as db from '../database.js';
import { cleanupAcpSession } from './acpCleanup.js';
import { bindMcpProxy, getMcpProxyIdFromServers } from './mcpProxyRegistry.js';
import { writeLog } from '../services/logger.js';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { modelOptionsFromProviderConfig, resolveModelSelection } from '../services/modelOptions.js';
import { getMcpServers } from './mcpServer.js';

const DEFAULT_COMPLETED_INVOCATION_TTL_MS = 10 * 60 * 1000;

export class SubAgentInvocationManager {
  constructor(deps = {}) {
    this.invocations = new Map();
    this.idempotentInvocations = new Map();
    this.completedInvocations = new Map();
    this.io = deps.io || null;
    this.db = deps.db || db;
    this.acpClientFactory = deps.acpClientFactory || ((pid) => providerRuntimeManager.getClient(pid));
    this.getProviderFn = deps.getProvider || getProvider;
    this.getProviderModuleFn = deps.getProviderModule || getProviderModule;
    this.log = deps.log || writeLog;
    this.now = deps.now || (() => Date.now());
    this.cleanupFn = deps.cleanupFn || cleanupAcpSession;
    this.bindMcpProxyFn = deps.bindMcpProxyFn || bindMcpProxy;
    this.getMcpServersFn = deps.getMcpServersFn || getMcpServers;
    this.resolveModelSelectionFn = deps.resolveModelSelectionFn || resolveModelSelection;
    this.modelOptionsFromProviderConfigFn = deps.modelOptionsFromProviderConfigFn || modelOptionsFromProviderConfig;
    this.completedInvocationTtlMs = deps.completedInvocationTtlMs ?? DEFAULT_COMPLETED_INVOCATION_TTL_MS;
  }

  setIo(io) {
    this.io = io;
  }

  getSnapshotsForParent(parentAcpSessionId) {
    const result = [];
    for (const inv of this.invocations.values()) {
      if (inv.parentAcpSessionId === parentAcpSessionId) {
        for (const agent of inv.agents.values()) {
          result.push(agent);
        }
      }
    }
    return result;
  }

  pruneCompletedInvocations(now = this.now()) {
    for (const [key, record] of this.completedInvocations.entries()) {
      if (now - record.completedAt > this.completedInvocationTtlMs) {
        this.completedInvocations.delete(key);
      }
    }
  }

  cancelAllForParent(parentAcpSessionId, providerId) {
    for (const inv of this.invocations.values()) {
      if (inv.parentAcpSessionId === parentAcpSessionId && inv.providerId === providerId) {
        if (inv.abortFn) inv.abortFn();
        for (const agent of inv.agents.values()) {
           agent.status = 'cancelled';
           try {
             const acpClient = this.acpClientFactory(providerId);
             if (acpClient && agent.acpId) {
               acpClient.transport.sendNotification('session/cancel', { sessionId: agent.acpId });
               if (acpClient.transport.pendingRequests) {
                 for (const [id, pending] of acpClient.transport.pendingRequests) {
                   if (pending.params?.sessionId === agent.acpId) {
                     pending.reject(new Error('Session cancelled'));
                     acpClient.transport.pendingRequests.delete(id);
                   }
                 }
               }
             }
           } catch (e) {
             this.log(`Error sending cancel to sub-agent ${agent.acpId}: ${e.message}`);
           }
        }
      }
    }
  }

  async runInvocation({ requests, model, providerId, parentAcpSessionId: explicitParentAcpSessionId = null, idempotencyKey = null }) {
    if (!this.io) return { content: [{ type: 'text', text: 'Error: Sub-agent system not available' }] };
    const safeRequests = Array.isArray(requests) ? requests : [];

    const provider = this.getProviderFn(providerId);
    const resolvedProviderId = provider.id;
    const acpClient = this.acpClientFactory(resolvedProviderId);
    if (!acpClient) return { content: [{ type: 'text', text: 'Error: Sub-agent system not available' }] };

    const parentAcpSessionId = explicitParentAcpSessionId || acpClient.lastSubAgentParentAcpId || null;

    if (idempotencyKey) {
      this.pruneCompletedInvocations();
      const active = this.idempotentInvocations.get(idempotencyKey);
      if (active?.promise) {
        this.log(`[SUB-AGENT] Duplicate invocation ${idempotencyKey}; returning active result`);
        return active.promise;
      }
      const completed = this.completedInvocations.get(idempotencyKey);
      if (completed?.result) {
        this.log(`[SUB-AGENT] Duplicate invocation ${idempotencyKey}; returning cached result`);
        return completed.result;
      }
    }

    const promise = this.executeInvocation({
      requests: safeRequests,
      model,
      provider,
      resolvedProviderId,
      acpClient,
      parentAcpSessionId
    });

    if (!idempotencyKey) return promise;

    this.idempotentInvocations.set(idempotencyKey, { promise, startedAt: this.now() });
    return promise.then(result => {
      this.idempotentInvocations.delete(idempotencyKey);
      this.completedInvocations.set(idempotencyKey, { result, completedAt: this.now() });
      return result;
    }).catch(err => {
      this.idempotentInvocations.delete(idempotencyKey);
      throw err;
    });
  }

  async executeInvocation({ requests, model, provider, resolvedProviderId, acpClient, parentAcpSessionId }) {
    this.log(`[SUB-AGENT] Spawning ${requests.length} sub-agent(s)`);

    const models = provider.config.models || {};
    const quickModelOptions = this.modelOptionsFromProviderConfigFn(models);
    const modelId = this.resolveModelSelectionFn(model || models.subAgent, models, quickModelOptions).modelId;
    const resolvedModelKey = modelId;

    const invocationId = `inv-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let parentUiId = null;
    if (parentAcpSessionId) {
      const parentSession = await this.db.getSessionByAcpId(resolvedProviderId, parentAcpSessionId);
      if (parentSession) parentUiId = parentSession.id;
    }

    this.io.emit('sub_agents_starting', { invocationId, parentUiId, providerId: resolvedProviderId, count: requests.length });

    let _aborted = false;
    const abortCallbacks = [];
    const onAbort = (cb) => abortCallbacks.push(cb);
    const abortFn = () => { _aborted = true; abortCallbacks.forEach(cb => cb()); };

    const invocationRecord = {
      invocationId,
      providerId: resolvedProviderId,
      parentAcpSessionId,
      parentUiId,
      requests,
      agents: new Map(),
      abortFn,
      status: 'spawning',
      startedAt: this.now(),
      completedAt: null
    };
    this.invocations.set(invocationId, invocationRecord);

    const sendWithTimeout = (method, params, timeoutMs = 600000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        onAbort(() => { clearTimeout(timer); reject(new Error('Aborted')); });
        acpClient.transport.sendRequest(method, params).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
      });
    };

    const setupPromises = requests.map((req, i) => {
      return new Promise(resolve => {
        setTimeout(async () => {
          if (_aborted) { resolve({ subAcpId: null, index: i, req, error: 'Aborted' }); return; }
          const agentName = req.agent || provider.config.defaultSubAgentName;
          if (!agentName) { resolve({ subAcpId: null, index: i, req, error: 'No agent configured' }); return; }
          const cwd = req.cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();

          try {
            const providerModule = await this.getProviderModuleFn(resolvedProviderId);
            const sessionParams = providerModule.buildSessionParams(agentName);
            const mcpServers = this.getMcpServersFn(resolvedProviderId);
            const result = await sendWithTimeout('session/new', { cwd, mcpServers, ...sessionParams }, 30000);
            const subAcpId = result.sessionId;
            this.bindMcpProxyFn(getMcpProxyIdFromServers(mcpServers), { providerId: resolvedProviderId, acpSessionId: subAcpId });
            this.log(`[SUB-AGENT ${i}] Created session ${subAcpId} (agent: ${agentName})`);

            const uiId = `sub-${subAcpId}`;
            
            const agentRecord = {
              providerId: resolvedProviderId,
              acpId: subAcpId,
              parentAcpSessionId,
              parentUiId,
              invocationId,
              uiId,
              name: req.name || `Agent ${i + 1}`,
              index: i,
              prompt: req.prompt,
              agent: agentName,
              model: resolvedModelKey,
              status: 'spawning'
            };
            invocationRecord.agents.set(subAcpId, agentRecord);

            await this.db.saveSession({
              id: uiId, acpSessionId: subAcpId,
              name: req.name || `Agent ${i + 1}: ${req.prompt.slice(0, 50)}`,
              model: resolvedModelKey || null, messages: [], isPinned: false,
              isSubAgent: true, forkedFrom: parentUiId,
              currentModelId: modelId || null,
              modelOptions: quickModelOptions,
              provider: resolvedProviderId,
            });

            if (modelId) {
              await sendWithTimeout('session/set_model', { sessionId: subAcpId, modelId }, 10000);
            }

            acpClient.sessionMetadata.set(subAcpId, {
              model: modelId || null, currentModelId: modelId || null, modelOptions: quickModelOptions,
              toolCalls: 0, successTools: 0, startTime: this.now(),
              usedTokens: 0, totalTokens: 0, promptCount: 0,
              lastResponseBuffer: '', lastThoughtBuffer: '',
              agentName, spawnContext: null, isSubAgent: true,
            });

            if (!parentAcpSessionId) {
              this.log('[SUB-AGENT] Warning: parent ACP session unknown, joining all sockets');
              const sockets = await this.io.fetchSockets();
              for (const s of sockets) s.join(`session:${subAcpId}`);
            } else {
              const parentRoom = `session:${parentAcpSessionId}`;
              const sockets = await this.io.fetchSockets();
              for (const s of sockets) {
                if (s.rooms.has(parentRoom)) s.join(`session:${subAcpId}`);
              }
            }
            this.io.emit('sub_agent_started', {
              providerId: resolvedProviderId,
              acpSessionId: subAcpId, uiId, parentUiId, index: i,
              name: req.name || `Agent ${i + 1}`,
              prompt: req.prompt, agent: agentName, model: resolvedModelKey,
              invocationId,
            });

            if (agentName !== provider.config.defaultSystemAgentName) {
              await providerModule.setInitialAgent(acpClient, subAcpId, agentName);
            }

            resolve({ subAcpId, index: i, req });
          } catch (err) {
            this.log(`[SUB-AGENT ${i}] Setup error: ${err.message}`);
            if (invocationRecord.agents.has(`sub-${i}`)) invocationRecord.agents.get(`sub-${i}`).status = 'failed';
            this.io.emit('sub_agent_completed', { providerId: resolvedProviderId, acpSessionId: `sub-${i}`, index: i, error: err.message });
            resolve({ subAcpId: null, index: i, req, error: err.message });
          }
        }, i * 1000); // 1 second stagger
      });
    });

    const sessions2 = await Promise.all(setupPromises);

    invocationRecord.status = 'running';

    const results = await Promise.all(sessions2.map(async (s) => {
      if (s.error) return { index: s.index, response: null, error: s.error };
      try {
        const agentRec = invocationRecord.agents.get(s.subAcpId);
        if (agentRec) agentRec.status = 'prompting';
        this.io.emit('sub_agent_status', {
          providerId: resolvedProviderId,
          acpSessionId: s.subAcpId,
          status: 'prompting'
        });
        await sendWithTimeout('session/prompt', {
          sessionId: s.subAcpId,
          prompt: [{ type: 'text', text: s.req.prompt }]
        });
        const meta = acpClient.sessionMetadata.get(s.subAcpId);
        const response = meta?.lastResponseBuffer?.trim() || '(no response)';
        if (agentRec) agentRec.status = 'completed';
        this.io.emit('sub_agent_completed', { providerId: resolvedProviderId, acpSessionId: s.subAcpId, index: s.index });
        this.log(`[SUB-AGENT ${s.index}] Completed: ${s.subAcpId}`);
        if (this.cleanupFn) this.cleanupFn(s.subAcpId, resolvedProviderId);
        acpClient.sessionMetadata.delete(s.subAcpId);
        return { index: s.index, response, error: null };
      } catch (err) {
        this.log(`[SUB-AGENT ${s.index}] Error: ${err.message}`);
        const agentRec = invocationRecord.agents.get(s.subAcpId);
        if (agentRec) agentRec.status = 'failed';
        this.io.emit('sub_agent_completed', { providerId: resolvedProviderId, acpSessionId: s.subAcpId, index: s.index, error: err.message });
        return { index: s.index, response: null, error: err.message };
      }
    }));

    const summary = results.map((r, i) => {
      const header = `## Agent ${i + 1}`;
      if (r.error) return `${header}\nError: ${r.error}`;
      return `${header}\n${r.response}`;
    }).join('\n\n---\n\n');

    this.log(`[SUB-AGENT] All ${requests.length} agents completed, returning summary (${summary.length} chars)`);
    invocationRecord.status = 'completed';
    invocationRecord.completedAt = this.now();
    this.invocations.delete(invocationId);
    
    return { content: [{ type: 'text', text: summary }] };
  }
}

export const subAgentInvocationManager = new SubAgentInvocationManager();
