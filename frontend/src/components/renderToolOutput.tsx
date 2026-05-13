import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import AnsiToHtml from 'ansi-to-html';
import { ACP_UX_RESULT_TYPES } from '../utils/acpUxTools';

const ansiConverter = new AnsiToHtml({ fg: '#c9d1d9', bg: '#0d1117', newline: true, escapeXML: true });

// eslint-disable-next-line no-control-regex
const hasAnsi = (str: string) => /\u001b\[/.test(str);
// eslint-disable-next-line no-control-regex
const stripAnsi = (str: string) => str.replace(/\u001b\[[0-9;]*m/g, '');
// Strip non-color terminal sequences (cursor, window title, mouse, etc.) but keep SGR color codes
// eslint-disable-next-line no-control-regex
const stripTerminalNoise = (str: string) => str.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[\?[0-9;]*[a-zA-Z]/g, '').replace(/\u001b\[[0-9;]*[A-HJ-T]/g, '');

const tryExtractShellOutput = (output: string): string | null => {
  if (!output.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(output);
    if ('stdout' in parsed || 'stderr' in parsed) {
      const parts: string[] = [];
      if (parsed.stdout) parts.push(parsed.stdout);
      if (parsed.stderr) parts.push(parsed.stderr);
      return stripAnsi(parts.join('\n')).trim() || '(no output)';
    }
  } catch { /* not JSON */ }
  return null;
};

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', cs: 'csharp',
  py: 'python', json: 'json', xml: 'xml', html: 'html', css: 'css',
  scss: 'scss', yaml: 'yaml', yml: 'yaml', md: 'markdown', sh: 'bash',
  ps1: 'powershell', cmd: 'batch', sql: 'sql', rs: 'rust', go: 'go',
  java: 'java', rb: 'ruby', toml: 'toml', env: 'bash', resx: 'xml',
  csproj: 'xml', sln: 'text', config: 'xml', txt: 'text',
};

const getLangFromPath = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext] || 'text';
};

type WebFetchResult = {
  type: 'web_fetch_result';
  url?: string;
  status?: number;
  contentType?: string;
  title?: string;
  text?: string;
};

type GrepSearchMatch = {
  filePath?: string;
  lineNumber?: number;
  line?: string;
  submatches?: Array<{ text?: string; start?: number; end?: number }>;
};

type GrepSearchResult = {
  type: typeof ACP_UX_RESULT_TYPES.grepSearch;
  pattern?: string;
  dirPath?: string;
  matchCount?: number;
  matches?: GrepSearchMatch[];
  context?: Array<{
    filePath?: string;
    lineNumber?: number;
    line?: string;
  }>;
  truncated?: boolean;
};

const tryParseJsonObject = (text: string): Record<string, unknown> | null => {
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isWebFetchResult = (value: Record<string, unknown> | null): value is WebFetchResult => (
  value?.type === 'web_fetch_result'
);

const isGrepSearchResult = (value: Record<string, unknown> | null): value is GrepSearchResult => (
  value?.type === ACP_UX_RESULT_TYPES.grepSearch
);

const renderHighlightedMatch = (line: string, submatches: GrepSearchMatch['submatches'] = []) => {
  if (!submatches.length) return line;

  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  [...submatches]
    .filter(match => Number.isInteger(match.start) && Number.isInteger(match.end) && (match.end as number) >= (match.start as number))
    .sort((a, b) => (a.start as number) - (b.start as number))
    .forEach((match, index) => {
      const start = Math.max(cursor, match.start as number);
      const end = Math.min(line.length, match.end as number);
      if (start > cursor) pieces.push(line.slice(cursor, start));
      if (end > start) {
        pieces.push(<mark key={`match-${index}`} className="grep-match-highlight">{line.slice(start, end)}</mark>);
      }
      cursor = Math.max(cursor, end);
    });

  if (cursor < line.length) pieces.push(line.slice(cursor));
  return pieces.length ? pieces : line;
};

/**
 * Renders tool output with priority: diff (create-only → syntax-highlighted, mixed → colored diff)
 * > ANSI terminal colors > shell JSON {stdout,stderr} > file read (syntax-highlighted)
 * > JSON (pretty-printed) > plain <pre>
 */
export const renderToolOutput = (output: string | undefined, _markdownComponents: object, filePath?: string): React.ReactNode => {
  if (!output) return 'No output or error details provided.';

  if ((output.includes('--- old') && output.includes('+++ new')) || output.startsWith('Index: ') || output.startsWith('===')) {
    const lines = output.split('\n');
    const addLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removeLines = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));
    const hasContentLines = addLines.length > 0 || removeLines.length > 0 || lines.some(l => l.startsWith('@@'));

    // Create-only diff (all additions, no removals) — show as syntax-highlighted code
    if (addLines.length > 0 && removeLines.length === 0 && filePath) {
      const code = addLines.map(l => l.slice(1)).join('\n');
      const lang = getLangFromPath(filePath);
      return (
        <SyntaxHighlighter style={vscDarkPlus} language={lang} PreTag="div" className="syntax-highlighter tool-output-code">
          {code}
        </SyntaxHighlighter>
      );
    }

    if (hasContentLines) {
      return (
        <div className="diff-output">
          {lines.map((line, i) => {
            let className = 'diff-line';
            if (line.startsWith('+') && !line.startsWith('+++')) className += ' diff-add';
            else if (line.startsWith('-') && !line.startsWith('---')) className += ' diff-remove';
            else if (line.startsWith('@@') || line.startsWith('Index: ') || line.startsWith('===')) className += ' diff-header';
            return <div key={i} className={className}>{line || ' '}</div>;
          })}
        </div>
      );
    }
  }

  const shellOutput = tryExtractShellOutput(output);

  // ANSI colored output (from MCP shell tool) — render with colors
  if (!shellOutput && hasAnsi(output)) {
    const cleaned = stripTerminalNoise(output);
    const html = ansiConverter.toHtml(cleaned);
    return <pre className="tool-output-pre ansi-output" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  let displayText = shellOutput ?? stripAnsi(output);

  // Strip wrapping markdown code blocks if present (often returned by CLI tools for file reads)
  const trimmedDisplay = displayText.trim();
  if (!shellOutput && trimmedDisplay.startsWith('```') && trimmedDisplay.endsWith('```')) {
    const codeLines = trimmedDisplay.split('\n');
    if (codeLines.length >= 2) {
      codeLines.shift(); // remove first line (```lang)
      codeLines.pop(); // remove last line (```)
      displayText = codeLines.join('\n');
    }
  }

  const structuredObject = !shellOutput ? tryParseJsonObject(displayText) : null;
  if (isWebFetchResult(structuredObject)) {
    const title = structuredObject.title?.trim();
    const bodyText = structuredObject.text || '';
    return (
      <div className="web-fetch-output">
        <div className="web-fetch-meta">
          {title && <div className="web-fetch-title">{title}</div>}
          {structuredObject.url && (
            <a className="web-fetch-url" href={structuredObject.url} target="_blank" rel="noreferrer">
              {structuredObject.url}
            </a>
          )}
          <div className="web-fetch-details">
            {structuredObject.status ? <span>Status {structuredObject.status}</span> : null}
            {structuredObject.contentType ? <span>{structuredObject.contentType}</span> : null}
          </div>
        </div>
        <pre className="web-fetch-text">{bodyText || 'No fetched page text returned.'}</pre>
      </div>
    );
  }

  if (isGrepSearchResult(structuredObject)) {
    const matches = structuredObject.matches || [];
    return (
      <div className="grep-output">
        <div className="grep-output-meta">
          <span>{structuredObject.matchCount ?? matches.length} matches</span>
          {structuredObject.pattern ? <span>Pattern {structuredObject.pattern}</span> : null}
          {structuredObject.dirPath ? <span>{structuredObject.dirPath}</span> : null}
          {structuredObject.truncated ? <span>Truncated</span> : null}
        </div>
        {matches.length ? (
          <div className="grep-match-list">
            {matches.map((match, index) => (
              <div className="grep-match-row" key={`${match.filePath || 'match'}-${match.lineNumber || index}-${index}`}>
                <div className="grep-match-location">
                  <span>{match.filePath || '(unknown file)'}</span>
                  {match.lineNumber ? <span>:{match.lineNumber}</span> : null}
                </div>
                <pre className="grep-match-line">{renderHighlightedMatch(match.line || '', match.submatches)}</pre>
              </div>
            ))}
          </div>
        ) : (
          <div className="grep-no-matches">No matches found.</div>
        )}
      </div>
    );
  }

  // File read: wrap in syntax-highlighted code block
  if (!shellOutput && filePath) {
    const lang = getLangFromPath(filePath);
    
    // Strip line numbers (e.g. "1\tcode" or "1  code") from file reads if >80% of lines have them
    const lines = displayText.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    // Only strip one space/tab after the number to preserve indentation!
    const numRegex = /^\s*\d+(?:\t| \| |: | )/;
    const numberedLines = nonEmptyLines.filter(l => numRegex.test(l)).length;
    
    let cleanText = displayText;
    let showLineNumbers = false;
    let startingLineNumber = 1;
    
    if (nonEmptyLines.length > 0 && numberedLines >= nonEmptyLines.length * 0.8) {
      const firstLineMatch = nonEmptyLines[0].match(/^\s*(\d+)/);
      if (firstLineMatch) startingLineNumber = parseInt(firstLineMatch[1], 10);
      
      cleanText = lines.map(l => {
        if (l.trim().length === 0) return l; // preserve empty lines
        return l.replace(numRegex, '');
      }).join('\n');
      showLineNumbers = true;
    }

    return (
      <SyntaxHighlighter 
        style={vscDarkPlus} 
        language={lang} 
        PreTag="div" 
        className="syntax-highlighter tool-output-code"
        showLineNumbers={showLineNumbers}
        startingLineNumber={startingLineNumber}
      >
        {cleanText}
      </SyntaxHighlighter>
    );
  }

  // JSON: pretty-print with syntax highlighting
  if (!shellOutput && (displayText.startsWith('{') || displayText.startsWith('['))) {
    try {
      const formatted = JSON.stringify(JSON.parse(displayText), null, 2);
      return (
        <SyntaxHighlighter style={vscDarkPlus} language="json" PreTag="div" className="syntax-highlighter tool-output-code">
          {formatted}
        </SyntaxHighlighter>
      );
    } catch { /* not valid JSON, fall through */ }
  }

  return (
    <pre className="tool-output-pre">{displayText}</pre>
  );
};
