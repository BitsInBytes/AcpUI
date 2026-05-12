import * as cheerio from 'cheerio';
import net from 'net';
import { TextDecoder } from 'util';
import { getWebFetchMcpConfig } from '../mcpConfig.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalizeProtocol(protocol) {
  return String(protocol || '').trim().toLowerCase();
}

function normalizeHost(host) {
  return String(host || '').trim().replace(/\.$/, '').toLowerCase();
}

function wildcardToRegex(pattern) {
  const escaped = String(pattern || '')
    .split('*')
    .map(part => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function ipv4ToInt(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function hostMatchesCidr(host, cidr) {
  const [range, bitsValue] = String(cidr || '').split('/');
  const hostInt = ipv4ToInt(host);
  const rangeInt = ipv4ToInt(range);
  const bits = Number(bitsValue);
  if (hostInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (hostInt & mask) === (rangeInt & mask);
}

function assertUrlAllowed(url, config) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const protocol = normalizeProtocol(parsed.protocol);
  const allowedProtocols = (config.allowedProtocols || []).map(normalizeProtocol);
  if (!allowedProtocols.includes(protocol)) {
    throw new Error(`URL protocol is not allowed by MCP web fetch config: ${parsed.protocol}`);
  }

  const host = normalizeHost(parsed.hostname);
  const blockedHosts = (config.blockedHosts || []).map(normalizeHost);
  if (blockedHosts.includes(host)) {
    throw new Error(`URL host is blocked by MCP web fetch config: ${host}`);
  }

  if ((config.blockedHostPatterns || []).some(pattern => wildcardToRegex(pattern).test(host))) {
    throw new Error(`URL host matches MCP web fetch blocked pattern: ${host}`);
  }

  if ((config.blockedCidrs || []).some(cidr => hostMatchesCidr(host, cidr))) {
    throw new Error(`URL host is blocked by MCP web fetch CIDR config: ${host}`);
  }

  return parsed;
}

function composeAbortSignal(parentSignal, timeoutMs) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`ux_web_fetch timed out after ${timeoutMs}ms`)), timeoutMs);

  const parentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) parentAbort();
  else parentSignal?.addEventListener?.('abort', parentAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.('abort', parentAbort);
    }
  };
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`ux_web_fetch response exceeds configured size cap (${contentLength} bytes > ${maxBytes} bytes).`);
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      throw new Error(`ux_web_fetch response exceeds configured size cap (${bytes} bytes > ${maxBytes} bytes).`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`ux_web_fetch response exceeds configured size cap (${total} bytes > ${maxBytes} bytes).`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchWithRedirects(inputUrl, config, signal) {
  let currentUrl = inputUrl;
  const visited = new Set();

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount++) {
    const parsed = assertUrlAllowed(currentUrl, config);
    if (visited.has(parsed.href)) {
      throw new Error(`ux_web_fetch redirect loop detected at ${parsed.href}`);
    }
    visited.add(parsed.href);

    const response = await fetch(parsed.href, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT
      }
    });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirectCount >= config.maxRedirects) {
        throw new Error(`ux_web_fetch exceeded configured redirect cap (${config.maxRedirects}).`);
      }
      currentUrl = new URL(response.headers.get('location'), parsed.href).href;
      continue;
    }

    return { response, finalUrl: parsed.href };
  }

  throw new Error(`ux_web_fetch exceeded configured redirect cap (${config.maxRedirects}).`);
}

export async function webFetch(url, { abortSignal } = {}) {
  const config = getWebFetchMcpConfig();
  const { signal, cleanup } = composeAbortSignal(abortSignal, config.timeoutMs);
  try {
    const { response, finalUrl } = await fetchWithRedirects(url, config, signal);

    if (!response.ok) {
      throw new Error(`Failed to fetch ${finalUrl}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await readResponseText(response, config.maxResponseBytes);

    if (!contentType.includes('text/html')) {
      return {
        type: 'web_fetch_result',
        url: finalUrl,
        status: response.status,
        contentType,
        title: '',
        text
      };
    }

    const $ = cheerio.load(text);
    $('script, style, noscript, iframe, svg, img, video, audio').remove();
    const title = $('title').first().text().replace(/\s+/g, ' ').trim();

    const plainText = $('body').text()
      .replace(/\s+/g, ' ')
      .trim();

    return {
      type: 'web_fetch_result',
      url: finalUrl,
      status: response.status,
      contentType,
      title,
      text: plainText || text
    };
  } finally {
    cleanup();
  }
}
