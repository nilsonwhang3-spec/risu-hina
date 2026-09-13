/** A foreground write must finish before another write or workspace switch. */
type Listener = (message: string | null) => void;
const listeners = new Set<Listener>();
let current: string | null = null;
export function onWriteProgress(listener: Listener): void {
  listeners.add(listener);
  listener(current);
}
export async function foregroundWrite<T>(work: (report: (message: string) => void) => Promise<T>): Promise<T> {
  if (current !== null) throw new Error('반영이 진행 중입니다. 완료될 때까지 기다려 주세요.');
  const report = (message: string | null): void => {
    current = message;
    for (const listener of listeners) listener(message);
  };
  report('반영할 변경을 준비하는 중…');
  try { return await work(message => report(message)); }
  finally { report(null); }
}

/** Bound memory/IPC pressure; drain all started saves before reporting failure. */
export async function boundedAssets<T>(items: T[], save: (item: T) => Promise<void>): Promise<void> {
  // Initialize the host storage once before concurrent calls (web AutoStorage.Init).
  if (!items.length) return;
  await save(items[0]);
  let next = 1, failed = false;
  let error: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await save(item); }
      catch (e) { if (!failed) error = e; failed = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length - 1) }, worker));
  if (failed) throw error;
}
