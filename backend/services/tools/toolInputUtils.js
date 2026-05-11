export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pushObject(candidates, value, seen) {
  const parsed = parseMaybeJson(value);
  if (!isPlainObject(parsed) || seen.has(parsed)) return;
  seen.add(parsed);
  candidates.push(parsed);

  for (const key of ['invocation', 'toolCall']) {
    const nested = parseMaybeJson(parsed[key]);
    if (isPlainObject(nested)) {
      pushObject(candidates, nested, seen);
    }
  }

  for (const key of ['arguments', 'args', 'params', 'input']) {
    const nested = parseMaybeJson(parsed[key]);
    if (isPlainObject(nested)) {
      pushObject(candidates, nested, seen);
    }
  }
}

export function collectInputObjects(...values) {
  const candidates = [];
  const seen = new Set();
  for (const value of values) {
    pushObject(candidates, value, seen);
  }
  return candidates;
}

export function firstStringValue(candidates, keys) {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate?.[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.length > 0) return value.join(' ');
    }
  }
  return '';
}

export function mergeInputObjects(candidates) {
  const merged = {};
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) Object.assign(merged, candidate);
  }
  return merged;
}

export function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
