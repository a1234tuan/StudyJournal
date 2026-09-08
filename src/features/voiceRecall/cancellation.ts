export class LinkedAbortController {
  readonly controller = new AbortController();
  private readonly cleanupCallbacks: Array<() => void> = [];

  constructor(parentSignals: readonly AbortSignal[] = []) {
    for (const signal of parentSignals) {
      if (signal.aborted) {
        this.controller.abort(signal.reason);
        break;
      }
      const abort = () => this.controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.cleanupCallbacks.push(() => signal.removeEventListener("abort", abort));
    }
  }

  get signal() {
    return this.controller.signal;
  }

  abort(reason?: unknown) {
    this.controller.abort(reason);
    this.dispose();
  }

  dispose() {
    while (this.cleanupCallbacks.length) this.cleanupCallbacks.pop()?.();
  }
}

export class VoiceRecallCancellationTree {
  private session = new AbortController();
  private turn?: LinkedAbortController;
  private requests = new Set<LinkedAbortController>();

  get sessionSignal() {
    return this.session.signal;
  }

  beginTurn() {
    this.cancelTurn("superseded");
    this.turn = new LinkedAbortController([this.session.signal]);
    return this.turn.signal;
  }

  beginRequest() {
    if (!this.turn) throw new Error("Cannot start a voice provider request without an active turn");
    const request = new LinkedAbortController([this.session.signal, this.turn.signal]);
    this.requests.add(request);
    request.signal.addEventListener("abort", () => this.requests.delete(request), { once: true });
    return { signal: request.signal, complete: () => { request.dispose(); this.requests.delete(request); } };
  }

  cancelTurn(reason: unknown = "cancelled") {
    for (const request of this.requests) request.abort(reason);
    this.requests.clear();
    this.turn?.abort(reason);
    this.turn = undefined;
  }

  cancelSession(reason: unknown = "session-ended") {
    this.cancelTurn(reason);
    this.session.abort(reason);
  }
}
