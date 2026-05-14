import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { glob as globModule } from 'glob';
import * as Diff from 'diff';
import { rgPath } from '@vscode/ripgrep';
import { fileURLToPath } from 'url';
import { getIoMcpConfig } from '../mcpConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const LEFT_SINGLE_CURLY_QUOTE = '\u2018';
const RIGHT_SINGLE_CURLY_QUOTE = '\u2019';
const LEFT_DOUBLE_CURLY_QUOTE = '\u201c';
const RIGHT_DOUBLE_CURLY_QUOTE = '\u201d';

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (utf8Bytes(text) <= maxBytes) return text;
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

export function limitTextOutput(value, maxBytes = getIoMcpConfig().maxOutputBytes, label = 'output') {
  const text = String(value ?? '');
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= maxBytes) return text;
  return `${truncateUtf8(text, maxBytes)}\n\n[${label} truncated after ${maxBytes} bytes; original output was ${totalBytes} bytes.]`;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function configRootToAbsolute(root) {
  if (root === '*') return '*';
  return path.isAbsolute(root) ? path.resolve(root) : path.resolve(REPO_ROOT, root);
}

function comparePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(targetPath, rootPath) {
  const target = comparePath(targetPath);
  const root = comparePath(rootPath);
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function configuredAllowedRoots() {
  const config = getIoMcpConfig();
  const roots = [...(config.allowedRoots || [])];
  if (config.autoAllowWorkspaceCwd) {
    roots.push(process.env.DEFAULT_WORKSPACE_CWD || process.cwd());
  }
  return roots;
}

function resolveAllowedPath(value, name) {
  const resolvedPath = path.resolve(requireString(value, name));
  const roots = configuredAllowedRoots();
  if (roots.includes('*')) return resolvedPath;

  const allowed = roots
    .map(configRootToAbsolute)
    .some(root => isPathWithinRoot(resolvedPath, root));

  if (!allowed) {
    throw new Error(`${name} is outside the configured MCP IO allowed roots: ${resolvedPath}`);
  }

  return resolvedPath;
}

function assertContentSize(content, maxBytes, operation) {
  const size = utf8Bytes(content);
  if (size > maxBytes) {
    throw new Error(`${operation} exceeds configured MCP IO size cap (${size} bytes > ${maxBytes} bytes).`);
  }
}

async function assertFileSize(filePath, maxBytes, operation) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${operation} target is not a file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`${operation} exceeds configured MCP IO size cap (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`);
  }
}

function normalizeQuotes(str) {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function findActualString(fileContent, searchString) {
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);

  if (searchIndex !== -1) {
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }

  return null;
}

function applyCurlyQuotes(str, char, left, right, isSingle = false) {
  const chars = [...str];
  const result = [];

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== char) {
      result.push(chars[i]);
      continue;
    }

    let isOpening = true;
    if (i > 0) {
      const prev = chars[i - 1];
      const isWhitespaceOrPunct = [' ', '\t', '\n', '\r', '(', '[', '{', '\u2014', '\u2013'].includes(prev);

      if (isSingle) {
        const next = i < chars.length - 1 ? chars[i + 1] : undefined;
        const prevIsLetter = /\p{L}/u.test(prev);
        const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
        isOpening = prevIsLetter && nextIsLetter ? false : isWhitespaceOrPunct;
      } else {
        isOpening = isWhitespaceOrPunct;
      }
    }

    result.push(isOpening ? left : right);
  }

  return result.join('');
}

function preserveQuoteStyle(oldString, actualOldString, newString) {
  if (oldString === actualOldString) {
    return newString;
  }

  const hasDoubleQuotes = actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes = actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString;
  }

  let result = newString;
  if (hasDoubleQuotes) {
    result = applyCurlyQuotes(result, '"', LEFT_DOUBLE_CURLY_QUOTE, RIGHT_DOUBLE_CURLY_QUOTE);
  }
  if (hasSingleQuotes) {
    result = applyCurlyQuotes(result, "'", LEFT_SINGLE_CURLY_QUOTE, RIGHT_SINGLE_CURLY_QUOTE, true);
  }

  return result;
}

export async function readFile(filePath, startLine, endLine) {
  const config = getIoMcpConfig();
  const resolvedPath = resolveAllowedPath(filePath, 'file_path');
  await assertFileSize(resolvedPath, config.maxReadBytes, 'ux_read_file');
  const content = await fs.readFile(resolvedPath, 'utf8');

  if (startLine === undefined && endLine === undefined) {
    return limitTextOutput(content, config.maxOutputBytes, 'ux_read_file output');
  }

  const lines = content.split('\n');
  const start = Math.max(1, startLine || 1) - 1;
  const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;

  return limitTextOutput(lines.slice(start, end).join('\n'), config.maxOutputBytes, 'ux_read_file output');
}

export async function writeFile(filePath, content) {
  const config = getIoMcpConfig();
  if (typeof content !== 'string') {
    throw new Error('content must be a string.');
  }
  assertContentSize(content, config.maxWriteBytes, 'ux_write_file content');
  const resolvedPath = resolveAllowedPath(filePath, 'file_path');
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, content, 'utf8');
}

export async function replaceText(filePath, oldString, newString, allowMultiple = false) {
  const config = getIoMcpConfig();
  if (typeof oldString !== 'string') throw new Error('old_string must be a string.');
  if (typeof newString !== 'string') throw new Error('new_string must be a string.');
  const resolvedPath = resolveAllowedPath(filePath, 'file_path');
  await assertFileSize(resolvedPath, config.maxReplaceBytes, 'replace');
  const rawContent = await fs.readFile(resolvedPath, 'utf8');
  const originalLineEndings = rawContent.includes('\r\n') ? '\r\n' : '\n';
  const content = rawContent.replace(/\r\n/g, '\n');
  const normalizedOldString = oldString.replace(/\r\n/g, '\n');
  const normalizedNewString = newString.replace(/\r\n/g, '\n');

  let newContent;
  let count;
  const actualOldString = findActualString(content, normalizedOldString);

  if (actualOldString) {
    count = content.split(actualOldString).length - 1;
    if (!allowMultiple && count > 1) {
      throw new Error(`Found multiple occurrences (${count}) of old_string. Set allow_multiple to true to replace all.`);
    }

    const actualNewString = preserveQuoteStyle(normalizedOldString, actualOldString, normalizedNewString);
    newContent = allowMultiple
      ? content.split(actualOldString).join(actualNewString)
      : content.replace(actualOldString, actualNewString);
  } else {
    if (allowMultiple) {
      throw new Error('old_string not found exactly, and fuzzy fallback matching is not supported with allow_multiple=true.');
    }

    newContent = replaceMostSimilarChunk(content, normalizedOldString, normalizedNewString);
    if (!newContent) {
      throw new Error(`old_string not found in file: ${filePath} (even after fuzzy matching).`);
    }
    count = 1;
  }

  if (originalLineEndings === '\r\n') {
    newContent = newContent.replace(/\n/g, '\r\n');
  }

  assertContentSize(newContent, config.maxReplaceBytes, 'replace result');
  await fs.writeFile(resolvedPath, newContent, 'utf8');
  return limitTextOutput(
    Diff.createPatch(resolvedPath, rawContent, newContent, 'old', 'new') ||
      `Successfully replaced ${count} occurrence(s).`,
    config.maxOutputBytes,
    'replace diff'
  );
}

function replaceMostSimilarChunk(whole, part, replace) {
  const wholeLines = whole.split('\n');
  const partLines = part.split('\n');
  const replaceLines = replace.split('\n');

  let result = perfectReplace(wholeLines, partLines, replaceLines);
  if (result) return result;

  if (partLines.length > 2 && partLines[0].trim() === '') {
    result = perfectReplace(wholeLines, partLines.slice(1), replaceLines);
    if (result) return result;
  }

  result = replaceWithMissingLeadingWhitespace(wholeLines, partLines, replaceLines);
  if (result) return result;

  return replaceClosestEditDistance(wholeLines, part, partLines, replaceLines);
}

function perfectReplace(wholeLines, partLines, replaceLines) {
  const partLen = partLines.length;
  if (partLen === 0) return null;

  for (let i = 0; i <= wholeLines.length - partLen; i++) {
    let match = true;
    for (let j = 0; j < partLen; j++) {
      if (wholeLines[i + j] !== partLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return [
        ...wholeLines.slice(0, i),
        ...replaceLines,
        ...wholeLines.slice(i + partLen)
      ].join('\n');
    }
  }

  return null;
}

function replaceWithMissingLeadingWhitespace(wholeLines, partLines, replaceLines) {
  const nonBlankPart = partLines.filter(line => line.trim() !== '');
  const nonBlankReplace = replaceLines.filter(line => line.trim() !== '');
  if (nonBlankPart.length === 0) return null;

  const leading = [...nonBlankPart, ...nonBlankReplace].map(line => line.length - line.trimStart().length);
  const minLeading = Math.min(...leading);
  let adjustedPart = partLines;
  let adjustedReplace = replaceLines;

  if (minLeading > 0) {
    adjustedPart = partLines.map(line => line.trim() ? line.substring(minLeading) : line);
    adjustedReplace = replaceLines.map(line => line.trim() ? line.substring(minLeading) : line);
  }

  const numPart = adjustedPart.length;
  for (let i = 0; i <= wholeLines.length - numPart; i++) {
    const chunk = wholeLines.slice(i, i + numPart);
    let allNonWhitespaceAgree = true;

    for (let j = 0; j < numPart; j++) {
      if (chunk[j].trimStart() !== adjustedPart[j].trimStart()) {
        allNonWhitespaceAgree = false;
        break;
      }
    }
    if (!allNonWhitespaceAgree) continue;

    const offsets = new Set();
    for (let j = 0; j < numPart; j++) {
      if (chunk[j].trim()) {
        offsets.add(chunk[j].substring(0, chunk[j].length - adjustedPart[j].length));
      }
    }

    if (offsets.size === 1) {
      const addLeading = Array.from(offsets)[0];
      const newReplaceLines = adjustedReplace.map(line => line.trim() ? addLeading + line : line);
      return [
        ...wholeLines.slice(0, i),
        ...newReplaceLines,
        ...wholeLines.slice(i + numPart)
      ].join('\n');
    }
  }

  return null;
}

function replaceClosestEditDistance(wholeLines, part, partLines, replaceLines) {
  const similarityThreshold = 0.8;
  let maxSimilarity = 0;
  let mostSimilarChunkStart = -1;
  let mostSimilarChunkEnd = -1;
  const scale = 0.1;
  const minLen = Math.floor(partLines.length * (1 - scale));
  const maxLen = Math.ceil(partLines.length * (1 + scale));

  for (let length = minLen; length <= maxLen; length++) {
    for (let i = 0; i <= wholeLines.length - length; i++) {
      const chunk = wholeLines.slice(i, i + length).join('\n');
      const similarity = getSimilarity(chunk, part);

      if (similarity > maxSimilarity && similarity) {
        maxSimilarity = similarity;
        mostSimilarChunkStart = i;
        mostSimilarChunkEnd = i + length;
      }
    }
  }

  if (maxSimilarity < similarityThreshold) {
    return null;
  }

  return [
    ...wholeLines.slice(0, mostSimilarChunkStart),
    ...replaceLines,
    ...wholeLines.slice(mostSimilarChunkEnd)
  ].join('\n');
}

function getSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const bigrams1 = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substring(i, i + 2);
    bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2);
    const count = bigrams1.get(bigram);
    if (count && count > 0) {
      bigrams1.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2.0 * intersectionSize) / (s1.length + s2.length - 2);
}

export async function listDirectory(dirPath) {
  const resolvedPath = resolveAllowedPath(dirPath, 'dir_path');
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  return entries.map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
}

export async function findFiles(pattern, dirPath) {
  requireString(pattern, 'pattern');
  const cwd = dirPath ? resolveAllowedPath(dirPath, 'dir_path') : resolveAllowedPath(process.cwd(), 'dir_path');
  return globModule(pattern, { cwd, absolute: true, nodir: true });
}

function stripTrailingLineEnding(value = '') {
  return String(value).replace(/\r?\n$/, '');
}

const GREP_CASE_MODES = new Set(['smart', 'sensitive', 'insensitive']);
const GREP_RESULT_MODES = new Set(['matches', 'files', 'count']);
const GREP_REGEX_ENGINES = new Set(['default', 'pcre2', 'auto']);
const RIPGREP_FILE_TYPE_PATTERN = /^[a-z0-9][a-z0-9_+-]*$/i;

function parseTextOrBytes(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.bytes === 'string') {
    try {
      return Buffer.from(value.bytes, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

function parseOptionalBoolean(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new Error(`${name} must be a boolean.`);
}

function parseOptionalInteger(value, name, min = 0) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}.`);
  }
  return parsed;
}

function parseEnumValue(value, name, allowed, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${name} must be one of: ${Array.from(allowed).join(', ')}.`);
  }
  return normalized;
}

function normalizeStringArray(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`).trim());
}

function normalizeFileTypes(value) {
  return normalizeStringArray(value, 'file_types').map(fileType => {
    if (!RIPGREP_FILE_TYPE_PATTERN.test(fileType)) {
      throw new Error(`file_types contains invalid ripgrep type: ${fileType}`);
    }
    return fileType;
  });
}

function normalizeGrepOptions(rawOptions = {}) {
  const legacyCaseSensitive = parseOptionalBoolean(rawOptions.caseSensitive, 'case_sensitive');
  const caseModeFromLegacy = legacyCaseSensitive === undefined
    ? undefined
    : (legacyCaseSensitive ? 'sensitive' : 'insensitive');
  const caseMode = parseEnumValue(rawOptions.caseMode ?? caseModeFromLegacy, 'case_mode', GREP_CASE_MODES, 'smart');

  const legacyContext = parseOptionalInteger(rawOptions.context, 'context', 0);
  const beforeContext = parseOptionalInteger(rawOptions.beforeContext, 'before_context', 0);
  const afterContext = parseOptionalInteger(rawOptions.afterContext, 'after_context', 0);

  const normalizedBeforeContext = beforeContext ?? legacyContext;
  const normalizedAfterContext = afterContext ?? legacyContext;

  const normalized = {
    caseMode,
    includeGlobs: normalizeStringArray(rawOptions.includeGlobs, 'include_globs'),
    excludeGlobs: normalizeStringArray(rawOptions.excludeGlobs, 'exclude_globs'),
    fileTypes: normalizeFileTypes(rawOptions.fileTypes),
    beforeContext: normalizedBeforeContext,
    afterContext: normalizedAfterContext,
    maxMatches: parseOptionalInteger(rawOptions.maxMatches, 'max_matches', 1),
    resultMode: parseEnumValue(rawOptions.resultMode, 'result_mode', GREP_RESULT_MODES, 'matches'),
    wordMatch: parseOptionalBoolean(rawOptions.wordMatch, 'word_match') || false,
    multiline: parseOptionalBoolean(rawOptions.multiline, 'multiline') || false,
    regexEngine: parseEnumValue(rawOptions.regexEngine, 'regex_engine', GREP_REGEX_ENGINES, 'default'),
    hidden: parseOptionalBoolean(rawOptions.hidden, 'hidden') || false,
    noIgnore: parseOptionalBoolean(rawOptions.noIgnore, 'no_ignore') || false,
    followSymlinks: parseOptionalBoolean(rawOptions.followSymlinks, 'follow_symlinks') || false,
    fixedStrings: parseOptionalBoolean(rawOptions.fixedStrings, 'fixed_strings') || false,
    abortSignal: rawOptions.abortSignal
  };

  if (normalized.fixedStrings && normalized.regexEngine !== 'default') {
    throw new Error('regex_engine cannot be used when fixed_strings is true.');
  }
  if (normalized.followSymlinks && !getIoMcpConfig().allowedRoots.includes('*')) {
    throw new Error('follow_symlinks requires io.allowedRoots to include "*" because symlinks can leave configured roots.');
  }

  return normalized;
}

function buildRipgrepArgs(pattern, normalizedOptions) {
  const args = ['--json'];

  if (normalizedOptions.caseMode === 'sensitive') args.push('--case-sensitive');
  if (normalizedOptions.caseMode === 'insensitive') args.push('--ignore-case');
  if (normalizedOptions.caseMode === 'smart') args.push('--smart-case');

  if (normalizedOptions.beforeContext !== undefined) args.push(`-B${normalizedOptions.beforeContext}`);
  if (normalizedOptions.afterContext !== undefined) args.push(`-A${normalizedOptions.afterContext}`);
  if (normalizedOptions.maxMatches !== undefined) args.push('--max-count', String(normalizedOptions.maxMatches));

  if (normalizedOptions.fixedStrings) args.push('--fixed-strings');
  if (normalizedOptions.wordMatch) args.push('--word-regexp');
  if (normalizedOptions.multiline) args.push('--multiline');
  if (normalizedOptions.hidden) args.push('--hidden');
  if (normalizedOptions.noIgnore) args.push('--no-ignore');
  if (normalizedOptions.followSymlinks) args.push('--follow');

  if (normalizedOptions.regexEngine === 'pcre2') args.push('--pcre2');
  if (normalizedOptions.regexEngine === 'auto') args.push('--auto-hybrid-regex');

  for (const fileType of normalizedOptions.fileTypes) {
    args.push('--type', fileType);
  }

  for (const includeGlob of normalizedOptions.includeGlobs) {
    args.push('--glob', includeGlob);
  }

  for (const excludeGlob of normalizedOptions.excludeGlobs) {
    const normalizedGlob = excludeGlob.replace(/^!+/, '').trim();
    if (!normalizedGlob) {
      throw new Error('exclude_globs entries must include a glob pattern.');
    }
    args.push('--glob', `!${normalizedGlob}`);
  }

  args.push('--', pattern, '.');
  return args;
}

function createBaseGrepResult(pattern, cwd, resultMode) {
  return {
    type: 'ux_grep_search_result',
    pattern,
    dirPath: cwd,
    resultMode,
    matchCount: 0,
    matches: [],
    context: [],
    files: [],
    totalMatches: 0,
    truncated: false
  };
}

function parseRipgrepJson(stdout, cwd, pattern, normalizedOptions) {
  const result = createBaseGrepResult(pattern, cwd, normalizedOptions.resultMode);
  const filesWithMatches = new Set();
  let summaryMatches = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'summary') {
      const matches = event.data?.stats?.matches;
      if (Number.isInteger(matches)) {
        summaryMatches = matches;
      }
      continue;
    }

    const data = event.data || {};
    const lineNumber = Number.isInteger(data.line_number) ? data.line_number : null;
    const filePathText = parseTextOrBytes(data.path);
    const filePath = filePathText ? path.resolve(cwd, filePathText) : null;

    if (event.type === 'match') {
      if (!filePath) continue;
      filesWithMatches.add(filePath);

      const submatches = Array.isArray(data.submatches)
        ? data.submatches.map(match => ({
          text: parseTextOrBytes(match.match),
          start: match.start,
          end: match.end
        }))
        : [];

      const lineText = stripTrailingLineEnding(parseTextOrBytes(data.lines));
      const matchIncrement = submatches.length || 1;
      result.totalMatches += matchIncrement;

      if (normalizedOptions.resultMode === 'matches') {
        result.matches.push({
          filePath,
          lineNumber,
          line: lineText,
          submatches
        });
      }
      continue;
    }

    if (event.type === 'context' && normalizedOptions.resultMode === 'matches') {
      if (!filePath || !lineNumber) continue;
      result.context.push({
        filePath,
        lineNumber,
        line: stripTrailingLineEnding(parseTextOrBytes(data.lines))
      });
    }
  }

  result.files = Array.from(filesWithMatches);

  if (summaryMatches !== null) {
    result.totalMatches = summaryMatches;
  }

  if (normalizedOptions.resultMode === 'matches') {
    result.matchCount = result.matches.length;
  } else if (normalizedOptions.resultMode === 'files') {
    result.matchCount = result.files.length;
    result.matches = [];
    result.context = [];
  } else {
    result.matchCount = result.totalMatches;
    result.matches = [];
    result.context = [];
  }

  return result;
}

function limitGrepResult(result, maxBytes) {
  let limited = result;
  if (utf8Bytes(JSON.stringify(limited)) <= maxBytes) return limited;

  limited = {
    ...result,
    matches: [...result.matches],
    context: [...result.context],
    files: [...result.files],
    truncated: true,
    maxOutputBytes: maxBytes
  };

  while (limited.context.length && utf8Bytes(JSON.stringify(limited)) > maxBytes) {
    limited.context.pop();
  }
  while (limited.matches.length && utf8Bytes(JSON.stringify(limited)) > maxBytes) {
    limited.matches.pop();
  }
  while (limited.files.length && utf8Bytes(JSON.stringify(limited)) > maxBytes) {
    limited.files.pop();
  }

  if (limited.resultMode === 'matches') {
    limited.matchCount = limited.matches.length;
  } else if (limited.resultMode === 'files') {
    limited.matchCount = limited.files.length;
    limited.matches = [];
    limited.context = [];
  } else {
    limited.matchCount = limited.totalMatches;
    limited.matches = [];
    limited.context = [];
  }

  if (utf8Bytes(JSON.stringify(limited)) > maxBytes) {
    limited.matches = [];
    limited.context = [];
    limited.files = [];
    if (limited.resultMode === 'matches' || limited.resultMode === 'files') {
      limited.matchCount = 0;
    }
  }

  return limited;
}

export async function grepSearch(pattern, dirPath, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      requireString(pattern, 'pattern');
    } catch (err) {
      reject(err);
      return;
    }

    let normalizedOptions;
    try {
      normalizedOptions = normalizeGrepOptions(options);
    } catch (err) {
      reject(err);
      return;
    }

    const config = getIoMcpConfig();
    const cwd = dirPath ? resolveAllowedPath(dirPath, 'dir_path') : resolveAllowedPath(process.cwd(), 'dir_path');
    const args = buildRipgrepArgs(pattern, normalizedOptions);

    const child = spawn(rgPath, args, { cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanupAbort = () => {
      normalizedOptions.abortSignal?.removeEventListener?.('abort', abortHandler);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      fn(value);
    };
    const abortHandler = () => {
      child.kill();
      finish(reject, new Error('ux_grep_search aborted'));
    };

    if (normalizedOptions.abortSignal?.aborted) {
      abortHandler();
      return;
    }
    normalizedOptions.abortSignal?.addEventListener?.('abort', abortHandler, { once: true });

    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (code === 0 || code === 1) {
        const parsed = parseRipgrepJson(stdout, cwd, pattern, normalizedOptions);
        finish(resolve, limitGrepResult(parsed, config.maxOutputBytes));
      } else {
        finish(reject, new Error(`ripgrep failed with code ${code}: ${stderr}`));
      }
    });
  });
}
