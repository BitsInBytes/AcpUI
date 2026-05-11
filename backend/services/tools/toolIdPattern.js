function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function placeholderSource(name) {
  if (name === 'mcpName') return '(?<mcpName>[^\\s,:/]+?)';
  if (name === 'toolName') return '(?<toolName>[A-Za-z0-9_.]+)';
  return '';
}

export function toolIdPatternToRegex(pattern) {
  if (!pattern || typeof pattern !== 'string') return null;
  let source = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith('{mcpName}', i)) {
      source += placeholderSource('mcpName');
      i += '{mcpName}'.length;
    } else if (pattern.startsWith('{toolName}', i)) {
      source += placeholderSource('toolName');
      i += '{toolName}'.length;
    } else {
      source += escapeRegExp(pattern[i]);
      i += 1;
    }
  }
  return new RegExp(source, 'i');
}

export function matchToolIdPattern(value, configOrPattern) {
  if (!value) return null;
  const pattern = typeof configOrPattern === 'string'
    ? configOrPattern
    : configOrPattern?.toolIdPattern;
  const regex = toolIdPatternToRegex(pattern);
  if (!regex) return null;

  const match = String(value).match(regex);
  if (!match?.groups?.toolName) return null;
  return {
    raw: match[0],
    mcpName: match.groups.mcpName,
    toolName: match.groups.toolName
  };
}

export function replaceToolIdPattern(value, configOrPattern, replacement) {
  if (!value) return value;
  const pattern = typeof configOrPattern === 'string'
    ? configOrPattern
    : configOrPattern?.toolIdPattern;
  const regex = toolIdPatternToRegex(pattern);
  if (!regex) return value;
  const globalRegex = new RegExp(regex.source, 'gi');
  return String(value).replace(globalRegex, (...args) => {
    const groups = args.at(-1);
    if (typeof replacement === 'function') {
      return replacement(groups);
    }
    return replacement ?? groups?.toolName ?? '';
  });
}
