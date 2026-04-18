import http from 'http';
import https from 'https';

const DEFAULT_TARGET = 'https://api.anthropic.com';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

let proxyState = null;

export async function startClaudeQuotaProxy({ env = process.env, log = () => {}, onQuota = () => {} } = {}) {
  const target = resolveTarget(env);

  if (proxyState?.server?.listening) {
    proxyState.onQuota = onQuota;
    proxyState.log = log;
    return {
      baseUrl: proxyState.baseUrl,
      target: proxyState.target.href,
      latestQuota: proxyState.latestQuota
    };
  }

  const state = {
    server: null,
    baseUrl: null,
    target,
    latestQuota: null,
    onQuota,
    log
  };

  state.server = http.createServer((request, response) => {
    proxyRequest(state, request, response);
  });

  proxyState = state;

  await new Promise((resolve, reject) => {
    state.server.once('error', reject);
    state.server.listen(0, '127.0.0.1', () => {
      state.server.off('error', reject);
      const address = state.server.address();
      state.baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  log(`[CLAUDE QUOTA] Proxy listening at ${state.baseUrl}, forwarding to ${target.origin}`);

  return {
    baseUrl: state.baseUrl,
    target: target.href,
    latestQuota: state.latestQuota
  };
}

export async function stopClaudeQuotaProxy() {
  const state = proxyState;
  proxyState = null;
  if (!state?.server?.listening) return;
  await new Promise(resolve => state.server.close(resolve));
}

export function getLatestClaudeQuota() {
  return proxyState?.latestQuota || null;
}

export function extractClaudeQuotaHeaders(headers, { url, status } = {}) {
  const raw = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.startsWith('anthropic-ratelimit-')) continue;
    raw[lowerKey] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (Object.keys(raw).length === 0) return null;

  const fiveHourReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-5h-reset');
  const sevenDayReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-7d-reset');
  const overageReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-overage-reset');
  const unifiedReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-reset');

  return {
    source: 'acpui-claude-provider-proxy',
    captured_at: new Date().toISOString(),
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    '5h_utilization': parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-5h-utilization')),
    '5h_status': headerValue(headers, 'anthropic-ratelimit-unified-5h-status'),
    '5h_reset': fiveHourReset,
    '5h_resets_at': resetSecondsToIso(fiveHourReset),
    '7d_utilization': parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-7d-utilization')),
    '7d_status': headerValue(headers, 'anthropic-ratelimit-unified-7d-status'),
    '7d_reset': sevenDayReset,
    '7d_resets_at': resetSecondsToIso(sevenDayReset),
    overage_utilization: parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-overage-utilization')),
    overage_status: headerValue(headers, 'anthropic-ratelimit-unified-overage-status'),
    overage_reset: overageReset,
    overage_resets_at: resetSecondsToIso(overageReset),
    fallback_percentage: parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-fallback-percentage')),
    representative_claim: headerValue(headers, 'anthropic-ratelimit-unified-representative-claim'),
    unified_status: headerValue(headers, 'anthropic-ratelimit-unified-status'),
    unified_reset: unifiedReset,
    unified_resets_at: resetSecondsToIso(unifiedReset),
    raw
  };
}

function proxyRequest(state, request, response) {
  const upstreamUrl = buildUpstreamUrl(state.target, request.url || '/');
  const client = upstreamUrl.protocol === 'http:' ? http : https;

  const upstreamRequest = client.request({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    method: request.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: {
      ...filterHeaders(request.headers),
      host: upstreamUrl.host
    }
  }, upstreamResponse => {
    const quotaData = extractClaudeQuotaHeaders(upstreamResponse.headers, {
      url: upstreamUrl.href,
      status: upstreamResponse.statusCode
    });

    if (quotaData) {
      state.latestQuota = quotaData;
      state.log(`[CLAUDE QUOTA] ${request.method} ${upstreamUrl.href} ${JSON.stringify(quotaData)}`);
      try {
        state.onQuota(quotaData);
      } catch (err) {
        state.log(`[CLAUDE QUOTA] Quota handler failed: ${err.message}`);
      }
    } else if (request.method === 'HEAD' || process.env.CLAUDE_QUOTA_PROXY_LOG_MISSES === 'true') {
      state.log(`[CLAUDE QUOTA] No quota headers on ${request.method} ${upstreamUrl.href} status=${upstreamResponse.statusCode}`);
    }

    response.writeHead(
      upstreamResponse.statusCode || 502,
      upstreamResponse.statusMessage,
      filterHeaders(upstreamResponse.headers)
    );
    upstreamResponse.pipe(response);
  });

  upstreamRequest.on('error', err => {
    state.log(`[CLAUDE QUOTA] Proxy request failed for ${request.method} ${upstreamUrl.href}: ${err.message}`);
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' });
    }
    response.end(JSON.stringify({ error: 'Anthropic quota proxy request failed', message: err.message }));
  });

  request.pipe(upstreamRequest);
}

function resolveTarget(env) {
  const configuredTarget = env.CLAUDE_QUOTA_PROXY_TARGET || env.ANTHROPIC_BASE_URL || DEFAULT_TARGET;
  let target;
  try {
    target = new URL(configuredTarget);
  } catch {
    target = new URL(DEFAULT_TARGET);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return new URL(DEFAULT_TARGET);
  }

  if (LOOPBACK_HOSTS.has(target.hostname) && !env.CLAUDE_QUOTA_PROXY_TARGET) {
    return new URL(DEFAULT_TARGET);
  }

  return target;
}

function buildUpstreamUrl(target, requestUrl) {
  const incoming = new URL(requestUrl, target.origin);
  const basePath = target.pathname && target.pathname !== '/'
    ? target.pathname.replace(/\/$/, '')
    : '';
  return new URL(`${basePath}${incoming.pathname}${incoming.search}`, target.origin);
}

function filterHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    filtered[key] = value;
  }
  return filtered;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetSeconds(headers, name) {
  const value = parseNumber(headerValue(headers, name));
  return value === null ? null : value;
}

function resetSecondsToIso(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
