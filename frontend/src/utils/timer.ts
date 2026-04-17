import { useState, useEffect } from 'react';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function useElapsed(startTime?: number, endTime?: number): string | null {
  const [now, setNow] = useState(() => Date.now());
  const isLive = startTime != null && endTime == null;

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isLive]);

  if (startTime == null) return null;
  const elapsed = (endTime ?? now) - startTime;
  return formatDuration(elapsed);
}
