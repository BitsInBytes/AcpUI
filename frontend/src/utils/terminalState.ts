// Track which terminal IDs have been spawned to avoid re-spawning on remount
const spawnedTerminals = new Set<string>();
export function addSpawnedTerminal(id: string) { spawnedTerminals.add(id); }
export function hasSpawnedTerminal(id: string) { return spawnedTerminals.has(id); }
export function clearSpawnedTerminal(id: string) { spawnedTerminals.delete(id); }
