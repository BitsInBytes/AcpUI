const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
export const BACKEND_PORT = import.meta.env.BACKEND_PORT || '3005';
export const BACKEND_URL = `${protocol}//${window.location.hostname}:${BACKEND_PORT}`;
