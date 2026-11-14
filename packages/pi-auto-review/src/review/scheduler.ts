/** Bound concurrent inference per endpoint, without sharing decisions or grants. */
const tails = new Map<string, Promise<void>>();

export async function withReviewerSlot<T>(
  endpoint: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("review queue aborted");
  const previous = tails.get(endpoint) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(endpoint, tail);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("review queue aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([previous, cancelled]);
    if (signal.aborted) throw new Error("review queue aborted");
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
    release();
    // A cancelled waiter cannot open the gate ahead of its active predecessor.
    void tail.then(() => { if (tails.get(endpoint) === tail) tails.delete(endpoint); });
  }
}
