import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import AnsiToHtml from 'ansi-to-html';

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
