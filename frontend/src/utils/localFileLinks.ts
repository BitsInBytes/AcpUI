const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+/;

function stripAngleBrackets(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function safeDecodeUri(value: string) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function stripQueryHash(value: string) {
  const index = value.search(/[?#]/);
  return index === -1 ? value : value.slice(0, index);
}

function stripLineSuffix(value: string) {
  return stripQueryHash(value).replace(/:\d+(?::\d+)?$/, '');
}

function fileUrlToPath(value: string) {
  if (!value.toLowerCase().startsWith('file:')) return null;

  try {
    const url = new URL(value);
    let filePath = decodeURIComponent(url.pathname);

    if (url.hostname && url.hostname !== 'localhost') {
      filePath = `//${url.hostname}${filePath}`;
    } else if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
      filePath = filePath.slice(1);
    }

    return filePath || null;
  } catch {
    return null;
  }
}

function isWindowsAbsolutePath(value: string) {
  return WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);
}

export function parseLocalFileLinkHref(href: string | undefined) {
  if (!href) return null;

  const unwrapped = stripAngleBrackets(href);
  if (!unwrapped) return null;

  const fileUrlPath = fileUrlToPath(unwrapped);
  if (fileUrlPath) return stripLineSuffix(fileUrlPath);

  const decoded = safeDecodeUri(unwrapped);
  if (!isWindowsAbsolutePath(decoded)) return null;

  return stripLineSuffix(decoded);
}
