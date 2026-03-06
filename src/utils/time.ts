export function nowIso(): string {
  return new Date().toISOString();
}

export function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return "unknown";
  }

  const diffMs = Date.now() - ts;
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  if (absSec < 60) {
    return `${absSec}s ago`;
  }
  const absMin = Math.floor(absSec / 60);
  if (absMin < 60) {
    return `${absMin}m ago`;
  }
  const absHour = Math.floor(absMin / 60);
  if (absHour < 24) {
    return `${absHour}h ago`;
  }
  const absDay = Math.floor(absHour / 24);
  return `${absDay}d ago`;
}
