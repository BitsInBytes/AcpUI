import fs from 'fs';
import path from 'path';
import * as db from '../database.js';
import { cleanupAcpSession } from './acpCleanup.js';
import { bindMcpProxy, getMcpProxyIdFromServers } from './mcpProxyRegistry.js';
import { writeLog } from '../services/logger.js';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { modelOptionsFromProviderConfig, resolveModelSelection } from '../services/modelOptions.js';
import { getAttachmentsRoot } from '../services/attachmentVault.js';
import { getMcpServers } from './mcpServer.js';
import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';
import { finalizeStreamPersistence, persistStreamEvent } from '../services/sessionStreamPersistence.js';

const ACTIVE_AGENT_STATUSES = new Set(['spawning', 'prompting', 'running', 'waiting_permission', 'cancelling']);
const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 120000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1000;
const DEFAULT_COMPLETED_INVOCATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COMPLETED_INVOCATION_MAX_ENTRIES = 200;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 500;

function positiveIntegerOrDefault(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const floored = Math.floor(numeric);
  return floored > 0 ? floored : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminalStatus(status) {
  return TERMINAL_AGENT_STATUSES.has(status);
}

function invocationStatusFromAgents(agents = []) {
  if (!agents.length) return 'failed';
  if (agents.some(agent => ACTIVE_AGENT_STATUSES.has(agent.status))) return 'running';
  if (agents.some(agent => agent.status === 'failed')) return 'failed';
  if (agents.some(agent => agent.status === 'cancelled')) return 'cancelled';
  return 'completed';
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function latestAssistantText(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string' && message.content.trim()) return message.content;
    const timelineText = (message.timeline || [])
      .filter(step => step?.type === 'text')
      .map(step => step.content || '')
      .join('');
    if (timelineText.trim()) return timelineText;
  }
  return '';
}

function initialSubAgentMessages(req, now) {
  const promptText = typeof req.prompt === 'string' ? req.prompt : JSON.stringify(req.prompt || '');
  return [
    { id: `user-${now}`, role: 'user', content: promptText },
    {
      id: `assistant-${now}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      timeline: [{ type: 'thought', content: '_Thinking..._' }],
      turnStartTime: now
    }
  ];
}

export class SubAgentInvocationManager {
  constructor(deps = {}) {
    this.invocations = new Map();
    this.idempotentInvocations = new Map();
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
    this.getAttachmentsRootFn = deps.getAttachmentsRootFn || getAttachmentsRoot;
    this.subAgentParentLinks = new Map();
    this.completedInvocationTtlMs = positiveIntegerOrDefault(
      deps.completedInvocationTtlMs,
      DEFAULT_COMPLETED_INVOCATION_TTL_MS
    );
    this.completedInvocationMaxEntries = positiveIntegerOrDefault(
      deps.completedInvocationMaxEntries,
      DEFAULT_COMPLETED_INVOCATION_MAX_ENTRIES
    );
    this.idempotencyTtlMs = positiveIntegerOrDefault(
      deps.idempotencyTtlMs,
      DEFAULT_IDEMPOTENCY_TTL_MS
    );
    this.idempotencyMaxEntries = positiveIntegerOrDefault(
      deps.idempotencyMaxEntries,
      DEFAULT_IDEMPOTENCY_MAX_ENTRIES
    );
  }

  setIo(io) {
    this.io = io;
  }

  getSnapshotsForParent(parentAcpSessionId) {
    const result = [];
    for (const inv of this.invocations.values()) {
      if (inv.parentAcpSessionId !== parentAcpSessionId) continue;
      const agents = Array.from(inv.agents.values());
      const totalCount = Number(inv.totalCount || agents.length || 0);
      const completedCount = this.completedAgentCount(inv);
      for (const agent of agents) {
        if (!isTerminalStatus(agent.status)) {
          result.push({
            ...agent,
            invocationStatus: inv.status,
            totalCount,
            completedCount,
            statusToolName: inv.statusToolName || ACP_UX_TOOL_NAMES.checkSubagents
          });
        }
      }
    }
    return result;
  }

  subAgentParentKey(providerId, acpSessionId) {
    return `${providerId}\u0000${acpSessionId}`;
  }

  trackSubAgentParent(providerId, childAcpSessionId, parentAcpSessionId) {
    if (!providerId || !childAcpSessionId || !parentAcpSessionId) return;
    this.subAgentParentLinks.set(this.subAgentParentKey(providerId, childAcpSessionId), {
      providerId,
      acpSessionId: childAcpSessionId,
      parentAcpSessionId
    });
  }

  collectDescendantAcpSessionIds(parentAcpSessionId, providerId) {
    const descendants = new Set(parentAcpSessionId ? [parentAcpSessionId] : []);
    let changed = true;

    while (changed) {
      changed = false;
      for (const link of this.subAgentParentLinks.values()) {
        if (link.providerId !== providerId) continue;
        if (!descendants.has(link.parentAcpSessionId) || descendants.has(link.acpSessionId)) continue;
        descendants.add(link.acpSessionId);
        changed = true;
      }

      for (const inv of this.invocations.values()) {
        if (inv.providerId !== providerId || !descendants.has(inv.parentAcpSessionId)) continue;
        for (const agent of inv.agents.values()) {
          if (agent.acpId && !descendants.has(agent.acpId)) {
            descendants.add(agent.acpId);
            changed = true;
          }
        }
      }
    }

    return descendants;
  }

  async runInvocation(args) {
    return this.startInvocation(args);
  }

  async startInvocation({ requests, model, providerId, parentAcpSessionId: explicitParentAcpSessionId = null, parentToolCallId = null, parentToolName = ACP_UX_TOOL_NAMES.invokeSubagents, idempotencyKey = null, abortSignal = null }) {
    if (!this.io) return textResult('Error: Sub-agent system not available');
    const safeRequests = Array.isArray(requests) ? requests : [];
    this.pruneCompletedState();

    const provider = this.getProviderFn(providerId);
    const resolvedProviderId = provider.id;
    const acpClient = this.acpClientFactory(resolvedProviderId);
    if (!acpClient) return textResult('Error: Sub-agent system not available');

    const parentAcpSessionId = explicitParentAcpSessionId || acpClient.lastSubAgentParentAcpId || null;

    if (idempotencyKey) {
      const cached = this.idempotentInvocations.get(idempotencyKey);
      if (cached?.promise) {
        this.log(`[SUB-AGENT] Duplicate invocation ${idempotencyKey}; returning active start result`);
        return cached.promise;
      }
      if (cached?.result) {
        this.log(`[SUB-AGENT] Duplicate invocation ${idempotencyKey}; returning cached start result`);
        return cached.result;
      }
    }

    const promise = this.executeStartInvocation({
      requests: safeRequests,
      model,
      provider,
      resolvedProviderId,
      acpClient,
      parentAcpSessionId,
      parentToolCallId,
      parentToolName,
      abortSignal
    });

    if (!idempotencyKey) return promise;

    this.idempotentInvocations.set(idempotencyKey, { promise, startedAt: this.now() });
    return promise.then(result => {
      this.idempotentInvocations.set(idempotencyKey, { result, completedAt: this.now() });
      this.pruneCompletedState();
      return result;
    }).catch(err => {
      this.idempotentInvocations.delete(idempotencyKey);
      this.pruneCompletedState();
      throw err;
    });
  }

  async executeStartInvocation({ requests, model, provider, resolvedProviderId, acpClient, parentAcpSessionId, parentToolCallId, parentToolName, abortSignal }) {
    this.log(`[SUB-AGENT] Starting async invocation for ${requests.length} sub-agent(s)`);

    const models = provider.config.models || {};
    const quickModelOptions = this.modelOptionsFromProviderConfigFn(models);
    const modelId = this.resolveModelSelectionFn(model || models.subAgent, models, quickModelOptions).modelId;
    const resolvedModelKey = modelId;

    let parentUiId = null;
    if (parentAcpSessionId) {
      const parentSession = await this.db.getSessionByAcpId(resolvedProviderId, parentAcpSessionId);
      if (parentSession) parentUiId = parentSession.id;
    }

    if (parentUiId) {
      const active = await this.db.getActiveSubAgentInvocationForParent(resolvedProviderId, parentUiId);
      if (active) return this.buildActiveInvocationResult(active);
      await this.cleanupPreviousInvocationsForParent(resolvedProviderId, parentUiId);
    }

    const invocationId = `inv-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const invocationRecord = {
      invocationId,
      providerId: resolvedProviderId,
      parentAcpSessionId,
      parentUiId,
      requests,
      model: resolvedModelKey,
      agents: new Map(),
      waiters: new Set(),
      status: 'spawning',
      totalCount: requests.length,
      startedAt: this.now(),
      completedAt: null,
      statusToolName: ACP_UX_TOOL_NAMES.checkSubagents,
      cancelled: false
    };
    this.invocations.set(invocationId, invocationRecord);

    await this.db.createSubAgentInvocation({
      invocationId,
      provider: resolvedProviderId,
      parentAcpSessionId,
      parentUiId,
      status: 'spawning',
      totalCount: requests.length,
      completedCount: 0,
      statusToolName: ACP_UX_TOOL_NAMES.checkSubagents,
      createdAt: invocationRecord.startedAt,
      updatedAt: invocationRecord.startedAt
    });

    if (parentAcpSessionId) {
      const title = parentToolName === ACP_UX_TOOL_NAMES.invokeCounsel ? 'Invoke Counsel' : 'Invoke Subagents';
      const parentToolEvent = {
        providerId: resolvedProviderId,
        sessionId: parentAcpSessionId,
        type: 'tool_update',
        id: parentToolCallId || `subagents-${invocationId}`,
        status: parentToolCallId ? 'in_progress' : 'completed',
        invocationId,
        title,
        titleSource: 'mcp_handler',
        toolName: parentToolName,
        canonicalName: parentToolName,
        mcpToolName: parentToolName,
        isAcpUxTool: true,
        toolCategory: 'sub_agent',
        isFileOperation: false
      };
      await persistStreamEvent(acpClient, parentAcpSessionId, parentToolEvent, {
        force: true,
        allowCompletedAssistantFallback: true
      });
      this.io.to?.(`session:${parentAcpSessionId}`)?.emit?.('system_event', parentToolEvent);
    }

    this.io.emit('sub_agents_starting', {
      invocationId,
      parentAcpSessionId,
      parentUiId,
      providerId: resolvedProviderId,
      count: requests.length,
      statusToolName: ACP_UX_TOOL_NAMES.checkSubagents
    });

    const abortFromSignal = () => {
      this.log(`[SUB-AGENT] Spawn tool aborted before return; cancelling invocation ${invocationId}`);
      void this.cancelInvocation(resolvedProviderId, invocationId);
    };
    if (abortSignal?.aborted) {
      abortFromSignal();
    } else if (abortSignal?.addEventListener) {
      abortSignal.addEventListener('abort', abortFromSignal, { once: true });
    }

    const setupResults = await Promise.all(requests.map((req, i) => this.spawnAgent({
      invocationRecord,
      req,
      index: i,
      provider,
      resolvedProviderId,
      acpClient,
      parentAcpSessionId,
      parentUiId,
      modelId,
      resolvedModelKey,
      quickModelOptions
    })));

    if (abortSignal?.removeEventListener) abortSignal.removeEventListener('abort', abortFromSignal);

    const liveAgents = setupResults.filter(result => result?.agentRecord && !result.error);
    if (liveAgents.length > 0 && !invocationRecord.cancelled) {
      invocationRecord.status = 'running';
      await this.db.updateSubAgentInvocationStatus(resolvedProviderId, invocationId, 'running', {
        totalCount: requests.length,
        completedCount: this.completedAgentCount(invocationRecord)
      });
      for (const result of liveAgents) {
        void this.startAgentPrompt({ invocationRecord, agentRecord: result.agentRecord, acpClient });
      }
    } else {
      await this.refreshInvocationCompletion(invocationRecord);
    }

    return this.buildStartedResult(invocationRecord);
  }

  async spawnAgent({ invocationRecord, req, index, provider, resolvedProviderId, acpClient, parentAcpSessionId, parentUiId, modelId, resolvedModelKey, quickModelOptions }) {
    await sleep(index * 1000);
    if (invocationRecord.cancelled) return { error: 'Cancelled' };

    const agentName = req.agent || provider.config.defaultSubAgentName;
    if (!agentName) {
      await this.recordSetupFailure({ invocationRecord, req, index, resolvedProviderId, parentAcpSessionId, parentUiId, resolvedModelKey, error: 'No agent configured' });
      return { error: 'No agent configured' };
    }

    const cwd = req.cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
    try {
      const providerModule = await this.getProviderModuleFn(resolvedProviderId);
      const sessionParams = providerModule.buildSessionParams(agentName);
      const mcpServers = this.getMcpServersFn(resolvedProviderId);
      const result = await this.sendWithTimeout(acpClient, 'session/new', { cwd, mcpServers, ...sessionParams }, 30000, invocationRecord);
      const subAcpId = result.sessionId;
      this.trackSubAgentParent(resolvedProviderId, subAcpId, parentAcpSessionId);
      this.bindMcpProxyFn(getMcpProxyIdFromServers(mcpServers), { providerId: resolvedProviderId, acpSessionId: subAcpId });
      this.log(`[SUB-AGENT ${index}] Created session ${subAcpId} (agent: ${agentName})`);

      const uiId = `sub-${subAcpId}`;
      const agentRecord = {
        providerId: resolvedProviderId,
        acpId: subAcpId,
        acpSessionId: subAcpId,
        parentAcpSessionId,
        parentUiId,
        invocationId: invocationRecord.invocationId,
        uiId,
        name: req.name || `Agent ${index + 1}`,
        index,
        prompt: req.prompt,
        agent: agentName,
        model: resolvedModelKey,
        status: 'spawning',
        response: null,
        error: null,
        startedAt: this.now(),
        completedAt: null
      };
      invocationRecord.agents.set(subAcpId, agentRecord);

      await this.db.saveSession({
        id: uiId,
        acpSessionId: subAcpId,
        name: req.name || `Agent ${index + 1}: ${String(req.prompt || '').slice(0, 50)}`,
        model: resolvedModelKey || null,
        messages: initialSubAgentMessages(req, this.now()),
        isPinned: false,
        isSubAgent: true,
        forkedFrom: parentUiId,
        parentAcpSessionId,
        currentModelId: modelId || null,
        modelOptions: quickModelOptions,
        provider: resolvedProviderId,
      });

      await this.db.addSubAgentInvocationAgent({
        invocationId: invocationRecord.invocationId,
        acpSessionId: subAcpId,
        uiId,
        index,
        name: agentRecord.name,
        prompt: req.prompt,
        agent: agentName,
        model: resolvedModelKey,
        status: 'spawning',
        createdAt: agentRecord.startedAt,
        updatedAt: agentRecord.startedAt
      });

      if (modelId) {
        await this.sendWithTimeout(acpClient, 'session/set_model', { sessionId: subAcpId, modelId }, 10000, invocationRecord);
      }

      acpClient.sessionMetadata.set(subAcpId, {
        model: modelId || null,
        currentModelId: modelId || null,
        modelOptions: quickModelOptions,
        toolCalls: 0,
        successTools: 0,
        startTime: this.now(),
        usedTokens: 0,
        totalTokens: 0,
        promptCount: 0,
        lastResponseBuffer: '',
        lastThoughtBuffer: '',
        agentName,
        spawnContext: null,
        isSubAgent: true,
        provider: resolvedProviderId
      });

      await this.joinSubAgentRoom(parentAcpSessionId, subAcpId);
      this.io.emit('sub_agent_started', {
        providerId: resolvedProviderId,
        acpSessionId: subAcpId,
        uiId,
        parentAcpSessionId,
        parentUiId,
        index,
        name: agentRecord.name,
        prompt: req.prompt,
        agent: agentName,
        model: resolvedModelKey,
        invocationId: invocationRecord.invocationId,
      });

      if (agentName !== provider.config.defaultSystemAgentName) {
        await providerModule.setInitialAgent(acpClient, subAcpId, agentName);
      }

      return { agentRecord };
    } catch (err) {
      this.log(`[SUB-AGENT ${index}] Setup error: ${err.message}`);
      await this.recordSetupFailure({ invocationRecord, req, index, resolvedProviderId, parentAcpSessionId, parentUiId, resolvedModelKey, error: err.message });
      return { error: err.message };
    }
  }

  async recordSetupFailure({ invocationRecord, req, index, resolvedProviderId, parentAcpSessionId, parentUiId, resolvedModelKey, error }) {
    const pseudoAcpId = `setup-failed-${invocationRecord.invocationId}-${index}`;
    const uiId = `sub-${pseudoAcpId}`;
    const now = this.now();
    const agentRecord = {
      providerId: resolvedProviderId,
      acpId: pseudoAcpId,
      acpSessionId: pseudoAcpId,
      parentAcpSessionId,
      parentUiId,
      invocationId: invocationRecord.invocationId,
      uiId,
      name: req.name || `Agent ${index + 1}`,
      index,
      prompt: req.prompt,
      agent: req.agent || null,
      model: resolvedModelKey,
      status: 'failed',
      response: null,
      error,
      startedAt: now,
      completedAt: now
    };
    invocationRecord.agents.set(pseudoAcpId, agentRecord);
    await this.db.addSubAgentInvocationAgent({
      invocationId: invocationRecord.invocationId,
      acpSessionId: pseudoAcpId,
      uiId,
      index,
      name: agentRecord.name,
      prompt: req.prompt,
      agent: agentRecord.agent,
      model: resolvedModelKey,
      status: 'failed',
      errorText: error,
      createdAt: now,
      updatedAt: now,
      completedAt: now
    });
    this.io.emit('sub_agent_started', {
      providerId: resolvedProviderId,
      acpSessionId: pseudoAcpId,
      uiId,
      parentAcpSessionId,
      parentUiId,
      index,
      name: agentRecord.name,
      prompt: req.prompt,
      agent: agentRecord.agent,
      model: resolvedModelKey,
      invocationId: invocationRecord.invocationId,
    });
    this.io.emit('sub_agent_completed', { providerId: resolvedProviderId, acpSessionId: pseudoAcpId, index, status: 'failed', error });
    await this.refreshInvocationCompletion(invocationRecord);
  }

  async startAgentPrompt({ invocationRecord, agentRecord, acpClient }) {
    if (invocationRecord.cancelled || isTerminalStatus(agentRecord.status)) return;
    acpClient._sessionStreamPersistenceDb = this.db;
    await this.setAgentStatus(invocationRecord, agentRecord, 'prompting');
    try {
      await acpClient.transport.sendRequest('session/prompt', {
        sessionId: agentRecord.acpId,
        prompt: [{ type: 'text', text: agentRecord.prompt }]
      });
      const meta = acpClient.sessionMetadata.get(agentRecord.acpId);
      const finalizedSession = await finalizeStreamPersistence(acpClient, agentRecord.acpId);
      const response = latestAssistantText(finalizedSession).trim() || meta?.lastResponseBuffer?.trim() || '(no response)';
      agentRecord.response = response;
      await this.setAgentStatus(invocationRecord, agentRecord, 'completed', { resultText: response });
      this.io.emit('sub_agent_completed', {
        providerId: invocationRecord.providerId,
        acpSessionId: agentRecord.acpId,
        index: agentRecord.index,
        invocationId: invocationRecord.invocationId,
        status: 'completed'
      });
      this.log(`[SUB-AGENT ${agentRecord.index}] Completed: ${agentRecord.acpId}`);
      if (this.cleanupFn) this.cleanupFn(agentRecord.acpId, invocationRecord.providerId);
      acpClient.sessionMetadata.delete(agentRecord.acpId);
    } catch (err) {
      if (invocationRecord.cancelled) {
        await finalizeStreamPersistence(acpClient, agentRecord.acpId);
        await this.setAgentStatus(invocationRecord, agentRecord, 'cancelled', { errorText: 'Cancelled' });
        this.io.emit('sub_agent_completed', {
          providerId: invocationRecord.providerId,
          acpSessionId: agentRecord.acpId,
          index: agentRecord.index,
          invocationId: invocationRecord.invocationId,
          status: 'cancelled'
        });
      } else {
        const message = err?.message || 'Unknown sub-agent error';
        this.log(`[SUB-AGENT ${agentRecord.index}] Error: ${message}`);
        await finalizeStreamPersistence(acpClient, agentRecord.acpId, {
          errorText: `\n\n:::ERROR:::\n${message}\n:::END_ERROR:::\n\n`
        });
        await this.setAgentStatus(invocationRecord, agentRecord, 'failed', { errorText: message });
        this.io.emit('sub_agent_completed', {
          providerId: invocationRecord.providerId,
          acpSessionId: agentRecord.acpId,
          index: agentRecord.index,
          invocationId: invocationRecord.invocationId,
          status: 'failed',
          error: message
        });
      }
    } finally {
      await this.refreshInvocationCompletion(invocationRecord);
    }
  }

  async setAgentStatus(invocationRecord, agentRecord, status, patch = {}) {
    agentRecord.status = status;
    if (patch.resultText !== undefined) agentRecord.response = patch.resultText;
    if (patch.errorText !== undefined) agentRecord.error = patch.errorText;
    if (isTerminalStatus(status)) agentRecord.completedAt = this.now();

    await this.db.updateSubAgentInvocationAgentStatus(invocationRecord.providerId, invocationRecord.invocationId, agentRecord.acpId, {
      status,
      resultText: patch.resultText,
      errorText: patch.errorText,
      completedAt: agentRecord.completedAt
    });

    this.io.emit('sub_agent_status', {
      providerId: invocationRecord.providerId,
      acpSessionId: agentRecord.acpId,
      invocationId: invocationRecord.invocationId,
      status
    });
    this.notifyInvocationChanged(invocationRecord.invocationId);
  }

  async refreshInvocationCompletion(invocationRecord) {
    const agents = [...invocationRecord.agents.values()];
    const totalCount = invocationRecord.requests?.length ?? agents.length;
    const status = agents.length
      ? invocationStatusFromAgents(agents)
      : (invocationRecord.cancelled ? 'cancelled' : totalCount === 0 ? 'completed' : invocationRecord.status);
    const completedCount = agents.filter(agent => agent.status === 'completed').length;
    invocationRecord.status = status;
    if (isTerminalStatus(status)) invocationRecord.completedAt = this.now();

    await this.db.updateSubAgentInvocationStatus(invocationRecord.providerId, invocationRecord.invocationId, status, {
      totalCount,
      completedCount,
      completedAt: invocationRecord.completedAt
    });

    this.io.emit('sub_agent_invocation_status', {
      providerId: invocationRecord.providerId,
      invocationId: invocationRecord.invocationId,
      parentAcpSessionId: invocationRecord.parentAcpSessionId,
      parentUiId: invocationRecord.parentUiId,
      status,
      completedCount,
      totalCount,
      statusToolName: invocationRecord.statusToolName
    });
    this.notifyInvocationChanged(invocationRecord.invocationId);
    this.pruneCompletedState();
  }

  completedAgentCount(invocationRecord) {
    return [...invocationRecord.agents.values()].filter(agent => agent.status === 'completed').length;
  }

  async sendWithTimeout(acpClient, method, params, timeoutMs, invocationRecord) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      acpClient.transport.sendRequest(method, params)
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
      if (invocationRecord.cancelled) {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      }
    });
  }

  async joinSubAgentRoom(parentAcpSessionId, subAcpId) {
    const sockets = await this.io.fetchSockets();
    if (!parentAcpSessionId) {
      this.log('[SUB-AGENT] Warning: parent ACP session unknown, joining all sockets');
      for (const s of sockets) s.join(`session:${subAcpId}`);
      return;
    }

    const parentRoom = `session:${parentAcpSessionId}`;
    for (const s of sockets) {
      if (s.rooms.has(parentRoom)) s.join(`session:${subAcpId}`);
    }
  }

  async cleanupPreviousInvocationsForParent(providerId, parentUiId) {
    const sessions = await this.db.getAllSessions(providerId);
    for (const session of sessions) {
      if (!session.isSubAgent || session.forkedFrom !== parentUiId) continue;
      if (session.acpSessionId && this.cleanupFn) {
        await this.cleanupFn(session.acpSessionId, session.provider || providerId, 'subagent-replacement');
      }
      const attachRoot = this.getAttachmentsRootFn(session.provider || providerId);
      const attachDir = path.join(attachRoot, session.id);
      if (fs.existsSync(attachDir)) fs.rmSync(attachDir, { recursive: true, force: true });
      await this.db.deleteSession(session.id);
    }
    await this.db.deleteSubAgentInvocationsForParent(providerId, parentUiId);
  }

  async getInvocationStatus({ providerId, invocationId, waitTimeoutMs = DEFAULT_STATUS_WAIT_TIMEOUT_MS, pollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS, abortSignal = null }) {
    if (!invocationId) return textResult('Error: invocationId is required.');
    this.pruneCompletedState();
    const timeoutAt = this.now() + Math.max(0, waitTimeoutMs);
    let snapshot = await this.db.getSubAgentInvocationWithAgents(providerId, invocationId);
    if (!snapshot) return this.buildMissingInvocationResult(invocationId);

    while (!this.isSnapshotTerminal(snapshot) && this.now() < timeoutAt && !abortSignal?.aborted) {
      const remaining = Math.max(0, timeoutAt - this.now());
      await this.waitForInvocationChange(invocationId, Math.min(pollIntervalMs, remaining), abortSignal);
      snapshot = await this.db.getSubAgentInvocationWithAgents(providerId, invocationId);
      if (!snapshot) return this.buildMissingInvocationResult(invocationId);
    }

    return this.buildStatusResult(snapshot);
  }

  isSnapshotTerminal(snapshot) {
    const agents = snapshot?.agents || [];
    if (!agents.length) return isTerminalStatus(snapshot?.status);
    return agents.every(agent => isTerminalStatus(agent.status));
  }

  waitForInvocationChange(invocationId, timeoutMs, abortSignal) {
    if (abortSignal?.aborted || timeoutMs <= 0) return Promise.resolve();
    const inv = this.invocations.get(invocationId);
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        if (inv) inv.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      if (inv) inv.waiters.add(done);
      abortSignal?.addEventListener?.('abort', done, { once: true });
    });
  }

  notifyInvocationChanged(invocationId) {
    const inv = this.invocations.get(invocationId);
    if (!inv?.waiters) return;
    for (const waiter of [...inv.waiters]) waiter();
  }

  pruneCompletedState(nowTs = this.now()) {
    this.pruneCompletedInvocations(nowTs);
    this.pruneCompletedIdempotency(nowTs);
  }

  evictInvocation(invocationId) {
    const inv = this.invocations.get(invocationId);
    if (!inv) return false;
    if (inv.waiters?.size) {
      for (const waiter of [...inv.waiters]) waiter();
      inv.waiters.clear();
    }
    this.invocations.delete(invocationId);
    return true;
  }

  pruneCompletedInvocations(nowTs = this.now()) {
    const completed = [];

    for (const [invocationId, inv] of this.invocations.entries()) {
      if (!isTerminalStatus(inv.status)) continue;
      const completedAt = Number.isFinite(inv.completedAt) ? inv.completedAt : nowTs;
      inv.completedAt = completedAt;

      if (nowTs - completedAt > this.completedInvocationTtlMs) {
        this.evictInvocation(invocationId);
        continue;
      }

      completed.push({ invocationId, completedAt });
    }

    if (completed.length <= this.completedInvocationMaxEntries) return;

    completed
      .sort((a, b) => a.completedAt - b.completedAt)
      .slice(0, completed.length - this.completedInvocationMaxEntries)
      .forEach(({ invocationId }) => {
        this.evictInvocation(invocationId);
      });
  }

  pruneCompletedIdempotency(nowTs = this.now()) {
    const completed = [];

    for (const [key, entry] of this.idempotentInvocations.entries()) {
      if (entry?.promise) continue;
      const hasResult = Object.prototype.hasOwnProperty.call(entry || {}, 'result');
      if (!hasResult) {
        this.idempotentInvocations.delete(key);
        continue;
      }
      const completedAt = Number.isFinite(entry.completedAt) ? entry.completedAt : nowTs;
      entry.completedAt = completedAt;

      if (nowTs - completedAt > this.idempotencyTtlMs) {
        this.idempotentInvocations.delete(key);
        continue;
      }

      completed.push({ key, completedAt });
    }

    if (completed.length <= this.idempotencyMaxEntries) return;

    completed
      .sort((a, b) => a.completedAt - b.completedAt)
      .slice(0, completed.length - this.idempotencyMaxEntries)
      .forEach(({ key }) => {
        this.idempotentInvocations.delete(key);
      });
  }

  async cancelInvocation(providerId, invocationId) {
    const inv = this.invocations.get(invocationId);
    if (inv) {
      await this.cancelInvocationRecord(inv);
      return;
    }

    const snapshot = await this.db.getSubAgentInvocationWithAgents(providerId, invocationId);
    if (!snapshot) return;
    await this.db.updateSubAgentInvocationStatus(providerId, invocationId, 'cancelled', {
      totalCount: snapshot.totalCount,
      completedCount: snapshot.completedCount,
      completedAt: this.now()
    });
    for (const agent of snapshot.agents || []) {
      if (!isTerminalStatus(agent.status)) {
        await this.db.updateSubAgentInvocationAgentStatus(providerId, invocationId, agent.acpSessionId, {
          status: 'cancelled',
          errorText: 'Cancelled',
          completedAt: this.now()
        });
      }
    }
  }

  async cancelInvocationRecord(inv) {
    if (inv.cancelled) return;
    inv.cancelled = true;
    inv.status = 'cancelling';
    if (typeof inv.abortFn === 'function') inv.abortFn();
    await this.db.updateSubAgentInvocationStatus(inv.providerId, inv.invocationId, 'cancelling');

    for (const agent of inv.agents.values()) {
      if (isTerminalStatus(agent.status)) continue;
      agent.status = 'cancelled';
      try {
        const acpClient = this.acpClientFactory(inv.providerId);
        if (acpClient && agent.acpId && !agent.acpId.startsWith('setup-failed-')) {
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
      await this.db.updateSubAgentInvocationAgentStatus(inv.providerId, inv.invocationId, agent.acpId, {
        status: 'cancelled',
        errorText: 'Cancelled',
        completedAt: this.now()
      });
      this.io.emit('sub_agent_completed', {
        providerId: inv.providerId,
        acpSessionId: agent.acpId,
        index: agent.index,
        invocationId: inv.invocationId,
        status: 'cancelled'
      });
    }

    await this.refreshInvocationCompletion(inv);
  }

  async cancelAllForParent(parentAcpSessionId, providerId) {
    const descendantAcpSessionIds = this.collectDescendantAcpSessionIds(parentAcpSessionId, providerId);
    const cancellations = [];
    for (const inv of this.invocations.values()) {
      if (inv.providerId === providerId && descendantAcpSessionIds.has(inv.parentAcpSessionId)) {
        cancellations.push(this.cancelInvocationRecord(inv));
      }
    }
    await Promise.all(cancellations);
  }

  buildStartedResult(invocation) {
    const total = invocation.requests.length;
    const completed = this.completedAgentCount(invocation);
    const abortToolName = ACP_UX_TOOL_NAMES.abortSubagents;
    return textResult(`Sub-agents have been started asynchronously.

Invocation ID: ${invocation.invocationId}
Status tool: ${invocation.statusToolName}
Abort tool: ${abortToolName}
Started agents: ${total}
Completed agents: ${completed}

Do not call ${ACP_UX_TOOL_NAMES.invokeSubagents} again for this same work. To wait for results, call:
${invocation.statusToolName}({ "invocationId": "${invocation.invocationId}" })

To check current status without waiting, call:
${invocation.statusToolName}({ "invocationId": "${invocation.invocationId}", "waitForCompletion": false })

If you no longer need the running agents, abort them with:
${abortToolName}({ "invocationId": "${invocation.invocationId}" })

The status tool waits for running agents up to the configured timeout by default, then returns completed results plus any agents still in progress. If agents are still running, call ${invocation.statusToolName} again with the same invocationId.

JSON:
${JSON.stringify({ invocationId: invocation.invocationId, statusToolName: invocation.statusToolName, abortToolName, status: invocation.status, completed, total }, null, 2)}`);
  }

  buildActiveInvocationResult(invocation) {
    const statusToolName = invocation.statusToolName || ACP_UX_TOOL_NAMES.checkSubagents;
    const abortToolName = ACP_UX_TOOL_NAMES.abortSubagents;
    return textResult(`This chat already has sub-agents running.

Invocation ID: ${invocation.invocationId}
Status tool: ${statusToolName}
Abort tool: ${abortToolName}

Do not start another sub-agent batch for this chat yet. To wait for results, call:
${statusToolName}({ "invocationId": "${invocation.invocationId}" })

To check current status without waiting, call:
${statusToolName}({ "invocationId": "${invocation.invocationId}", "waitForCompletion": false })

If you no longer need the running agents, abort them with:
${abortToolName}({ "invocationId": "${invocation.invocationId}" })

When that status reports completed, failed, or cancelled for all agents, you may start a new batch.

JSON:
${JSON.stringify({ invocationId: invocation.invocationId, statusToolName, abortToolName, status: invocation.status, completed: invocation.completedCount, total: invocation.totalCount }, null, 2)}`);
  }

  buildMissingInvocationResult(invocationId) {
    return textResult(`Sub-agent invocation not found.

Invocation ID: ${invocationId}

The invocation may have been deleted with its parent chat or replaced by a newer sub-agent batch.`);
  }

  buildStatusResult(snapshot) {
    const agents = snapshot.agents || [];
    const status = agents.length ? invocationStatusFromAgents(agents) : snapshot.status;
    const completedAgents = agents.filter(agent => agent.status === 'completed');
    const failedAgents = agents.filter(agent => agent.status === 'failed');
    const cancelledAgents = agents.filter(agent => agent.status === 'cancelled');
    const activeAgents = agents.filter(agent => !isTerminalStatus(agent.status));
    const statusToolName = snapshot.statusToolName || ACP_UX_TOOL_NAMES.checkSubagents;
    const abortToolName = ACP_UX_TOOL_NAMES.abortSubagents;

    const lines = [
      `Sub-agent invocation status: ${status}`,
      `Invocation ID: ${snapshot.invocationId}`,
      `Status tool: ${statusToolName}`,
      `Abort tool: ${abortToolName}`,
      `Completed: ${completedAgents.length} / ${agents.length}`,
      ''
    ];

    if (completedAgents.length) {
      lines.push('Completed results:');
      for (const agent of completedAgents) {
        lines.push(`## Agent ${agent.index + 1}: ${agent.name || 'Sub-agent'}`);
        lines.push(agent.resultText || '(no response)');
        lines.push('');
      }
    }

    if (failedAgents.length) {
      lines.push('Failed agents:');
      for (const agent of failedAgents) lines.push(`- Agent ${agent.index + 1}: ${agent.name || 'Sub-agent'} - ${agent.errorText || 'Failed'}`);
      lines.push('');
    }

    if (cancelledAgents.length) {
      lines.push('Aborted agents:');
      for (const agent of cancelledAgents) lines.push(`- Agent ${agent.index + 1}: ${agent.name || 'Sub-agent'}`);
      lines.push('');
    }

    if (activeAgents.length) {
      lines.push('Still running:');
      for (const agent of activeAgents) lines.push(`- Agent ${agent.index + 1}: ${agent.name || 'Sub-agent'} (${agent.status})`);
      lines.push('');
      lines.push(`Call ${statusToolName}({ "invocationId": "${snapshot.invocationId}" }) again to continue waiting.`);
      lines.push(`To check current status without waiting, call ${statusToolName}({ "invocationId": "${snapshot.invocationId}", "waitForCompletion": false }).`);
      lines.push(`To abort running agents, call ${abortToolName}({ "invocationId": "${snapshot.invocationId}" }).`);
    } else {
      lines.push('All sub-agents are now terminal. Do not call the status tool again for this invocation unless you need to re-read the final results.');
    }

    lines.push('');
    lines.push('JSON:');
    lines.push(JSON.stringify({
      invocationId: snapshot.invocationId,
      statusToolName,
      abortToolName,
      status,
      completed: completedAgents.length,
      failed: failedAgents.length,
      cancelled: cancelledAgents.length,
      running: activeAgents.length,
      total: agents.length
    }, null, 2));

    return textResult(lines.join('\n'));
  }
}

export const subAgentInvocationManager = new SubAgentInvocationManager();
