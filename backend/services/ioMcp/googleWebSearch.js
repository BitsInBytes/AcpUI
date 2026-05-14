import { GoogleGenAI } from '@google/genai';
import { TextEncoder, TextDecoder } from 'util';
import { getGoogleSearchMcpConfig } from '../mcpConfig.js';

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (utf8Bytes(text) <= maxBytes) return text;
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

function limitOutput(value, maxBytes) {
  const text = String(value ?? '');
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= maxBytes) return text;
  return `${truncateUtf8(text, maxBytes)}\n\n[ux_google_web_search output truncated after ${maxBytes} bytes; original output was ${totalBytes} bytes.]`;
}

function abortReasonToError(reason) {
  if (reason instanceof Error) return reason;
  if (reason === undefined || reason === null) return new Error('aborted');
  return new Error(String(reason));
}

async function withTimeout(promise, timeoutMs, abortSignal = null) {
  let timeout;
  let abortListener = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  const abortPromise = new Promise((_, reject) => {
    if (!abortSignal) return;
    if (abortSignal.aborted) {
      reject(abortReasonToError(abortSignal.reason));
      return;
    }
    abortListener = () => reject(abortReasonToError(abortSignal.reason));
    abortSignal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    clearTimeout(timeout);
    if (abortListener && abortSignal?.removeEventListener) {
      abortSignal.removeEventListener('abort', abortListener);
    }
  }
}

export async function googleWebSearch(query, options = {}) {
  const config = getGoogleSearchMcpConfig();
  const apiKey = options.apiKey || config.apiKey;
  const timeoutMs = options.timeoutMs || config.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes || config.maxOutputBytes;
  const abortSignal = options.abortSignal || null;

  if (!apiKey) {
    throw new Error('googleSearch.apiKey is missing in MCP config.');
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await withTimeout(ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: query }] }],
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.3
      }
    }), timeoutMs, abortSignal);

    const responseText = response.text || '';
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const sources = groundingMetadata?.groundingChunks;
    const groundingSupports = groundingMetadata?.groundingSupports;

    if (!responseText.trim()) {
      return `No search results or information found for query: "${query}"`;
    }

    let modifiedResponseText = responseText;
    const sourceListFormatted = [];

    if (sources?.length > 0) {
      sources.forEach((source, index) => {
        const title = source.web?.title || 'Untitled';
        const uri = source.web?.uri || 'No URI';
        sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`);
      });

      if (groundingSupports?.length > 0) {
        const insertions = [];
        groundingSupports.forEach(support => {
          if (support.segment && support.groundingChunkIndices) {
            const citationMarker = support.groundingChunkIndices
              .map(chunkIndex => `[${chunkIndex + 1}]`)
              .join('');
            insertions.push({
              index: support.segment.endIndex,
              marker: citationMarker
            });
          }
        });

        insertions.sort((a, b) => b.index - a.index);
        const encoder = new TextEncoder();
        const responseBytes = encoder.encode(modifiedResponseText);
        const parts = [];
        let lastIndex = responseBytes.length;

        for (const insertion of insertions) {
          const position = Math.min(insertion.index, lastIndex);
          parts.unshift(responseBytes.subarray(position, lastIndex));
          parts.unshift(encoder.encode(insertion.marker));
          lastIndex = position;
        }
        parts.unshift(responseBytes.subarray(0, lastIndex));

        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const finalBytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          finalBytes.set(part, offset);
          offset += part.length;
        }
        modifiedResponseText = new TextDecoder().decode(finalBytes);
      }

      if (sourceListFormatted.length > 0) {
        modifiedResponseText += `\n\nSources:\n${sourceListFormatted.join('\n')}`;
      }
    }

    return limitOutput(`Web search results for "${query}":\n\n${modifiedResponseText}`, maxOutputBytes);
  } catch (error) {
    throw new Error(`Google Web Search failed: ${error.message}`, { cause: error });
  }
}
