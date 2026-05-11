function stateKey({ providerId, sessionId, toolCallId }) {
  if (!sessionId || !toolCallId) return '';
  return `${providerId || 'default'}::${sessionId}::${toolCallId}`;
}

function normalizeTitle(title) {
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
}

function isGenericTitle(title) {
  const normalized = normalizeTitle(title).toLowerCase();
  return !normalized ||
    normalized === 'running' ||
    normalized === 'running tool' ||
    normalized === 'tool' ||
    normalized.startsWith('tool:') ||
    normalized.startsWith('running:');
}

const TITLE_SOURCE_PRIORITY = {
  unknown: 0,
  cached: 1,
  provider: 2,
  tool_handler: 3,
  mcp_handler: 4
};

export function shouldUseTitle(candidate, current) {
  const candidateTitle = normalizeTitle(candidate?.title ?? candidate);
  const currentTitle = normalizeTitle(current?.title ?? current);
  if (!candidateTitle) return false;
  if (!currentTitle) return true;

  const candidateSource = candidate?.source || 'unknown';
  const currentSource = current?.source || 'unknown';
  const candidatePriority = TITLE_SOURCE_PRIORITY[candidateSource] ?? 0;
  const currentPriority = TITLE_SOURCE_PRIORITY[currentSource] ?? 0;
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;

  const candidateGeneric = isGenericTitle(candidateTitle);
  const currentGeneric = isGenericTitle(currentTitle);
  if (candidateGeneric !== currentGeneric) return !candidateGeneric;

  const candidateHasDetail = candidateTitle.includes(':');
  const currentHasDetail = currentTitle.includes(':');
  if (candidateHasDetail !== currentHasDetail) return candidateHasDetail;

  return candidateTitle.length > currentTitle.length;
}

export class ToolCallState {
  constructor() {
    this.records = new Map();
  }

  key(input) {
    return stateKey(input);
  }

  get(providerId, sessionId, toolCallId) {
    const key = stateKey({ providerId, sessionId, toolCallId });
    return key ? this.records.get(key) || null : null;
  }

  upsert(invocation = {}) {
    const key = stateKey(invocation);
    if (!key) return { ...invocation };

    const existing = this.records.get(key) || {};
    const next = {
      ...existing,
      ...invocation,
      identity: {
        ...(existing.identity || {}),
        ...(invocation.identity || {})
      },
      input: {
        ...(existing.input || {}),
        ...(invocation.input || {})
      },
      display: {
        ...(existing.display || {}),
        ...(invocation.display || {})
      },
      category: {
        ...(existing.category || {}),
        ...(invocation.category || {})
      },
      toolSpecific: {
        ...(existing.toolSpecific || {}),
        ...(invocation.toolSpecific || {})
      }
    };

    const existingTitle = existing.display?.title
      ? { title: existing.display.title, source: existing.display.titleSource }
      : null;
    const candidateTitle = invocation.display?.title
      ? { title: invocation.display.title, source: invocation.display.titleSource }
      : null;

    if (shouldUseTitle(existingTitle, candidateTitle)) {
      next.display.title = existing.display.title;
      next.display.titleSource = existing.display.titleSource;
    } else if (candidateTitle?.title) {
      next.display.title = candidateTitle.title;
      next.display.titleSource = candidateTitle.source;
    }

    this.records.set(key, next);
    return next;
  }

  patch(providerId, sessionId, toolCallId, patch) {
    return this.upsert({ providerId, sessionId, toolCallId, ...patch });
  }

  clearSession(providerId, sessionId) {
    for (const [key, record] of this.records.entries()) {
      if (record.providerId === providerId && record.sessionId === sessionId) {
        this.records.delete(key);
      }
    }
  }

  clear() {
    this.records.clear();
  }
}

export const toolCallState = new ToolCallState();
