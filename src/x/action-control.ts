export class ActionStoppedError extends Error {
  constructor() {
    super("stopped");
    this.name = "ActionStoppedError";
  }
}

export class ActionDeadlineError extends ActionStoppedError {
  constructor() { super(); this.name = "ActionDeadlineError"; }
}

let stopped = true;
let deadline = Infinity;
let controller = new AbortController();
controller.abort();

export function beginAction(deadlineAt = Infinity): void {
  controller = new AbortController();
  deadline = deadlineAt;
  stopped = false;
}

export function stopActions(): void {
  stopped = true;
  controller.abort();
}

export function actionSignal(): AbortSignal {
  return controller.signal;
}

export function actionDeadline(): number { return deadline; }

export function isActionStopped(): boolean {
  return stopped;
}

export function assertActionActive(): void {
  if (Date.now() >= deadline) { stopActions(); throw new ActionDeadlineError(); }
  if (stopped) throw new ActionStoppedError();
}
