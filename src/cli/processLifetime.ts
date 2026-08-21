export async function runWithProcessLifetime<T>(work: () => Promise<T>): Promise<T> {
  // Promise-only adapters may not register a Node handle while work is pending.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}
