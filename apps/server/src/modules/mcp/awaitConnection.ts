// Cancelling one waiter must not abort initialization shared by other callers.
export async function awaitConnection(pending: Promise<void>, signal?: AbortSignal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
