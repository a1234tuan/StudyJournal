export class CommittedWriteError<Value> extends Error {
  constructor(readonly value: Value, readonly retry: () => Promise<void>) {
    super("内容已经写入，后续刷新或备份准备尚未完成。");
    this.name = "CommittedWriteError";
  }
}

export function createCommittedWriteRetry(actions: Array<() => Promise<unknown>>) {
  let index = 0;
  let running: Promise<void> | undefined;
  const advance = async () => {
    while (index < actions.length) {
      await actions[index]();
      index += 1;
    }
  };
  return () => {
    if (!running) running = advance().finally(() => { running = undefined; });
    return running;
  };
}

export async function finishCommittedWrite<Value>(value: Value, actions: Array<() => Promise<unknown>>): Promise<Value> {
  const retry = createCommittedWriteRetry(actions);
  try {
    await retry();
  } catch {
    throw new CommittedWriteError(value, retry);
  }
  return value;
}
