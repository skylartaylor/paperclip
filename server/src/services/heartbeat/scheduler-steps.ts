/**
 * Step-attributed, never-swallowed heartbeat-scheduler interval runner.
 *
 * The heartbeat-scheduler interval drives two independent schedulers: the issue-monitor timer tick
 * and the routine tick. Before this module the whole interval body ran inside one promise whose
 * rejection handler discarded the error:
 *
 *   tracked = Promise.resolve(work).then(() => undefined, () => undefined);   // no log, no metric
 *
 * A throw anywhere between `scheduled.timers.wake()` and `scheduled.routines.wake()` therefore
 * skipped the routine tick for that interval with no log line, no metric and no HTTP symptom, while
 * timer ticks kept firing on the interval and the API stayed healthy. That is the silent routine-scheduler stall: a
 * routine scheduler that stayed dead for 44 minutes, with zero ERROR lines to show for it.
 *
 * Two invariants this module enforces ("monitoring that stops monitoring must itself alert"):
 *
 *  1. No scheduled work is dropped silently. Every rejection is logged at error level together with
 *     the name of the step that produced it.
 *  2. A failing step cannot starve the steps that follow it. The failure is logged and the remaining
 *     steps still run, so one broken sweep can no longer take the routine tick down with it.
 *
 * This module owns the interval's step sequencing; the heartbeat modules under
 * `services/heartbeat/` own the work each step performs, and its focused test sits beside it.
 *
 * Ordering is preserved: steps run in array order, free-running steps are registered with the
 * tracker (so shutdown still drains them) and `await: true` steps are awaited before the next one
 * starts.
 */

export type HeartbeatSchedulerLogger = {
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type HeartbeatSchedulerWorkTracker = {
  /** Registers fire-and-forget work so shutdown can drain it. Rejections are logged, never discarded. */
  track: (work: unknown, step?: string) => void;
  /** Resolves once every tracked promise has settled (used by graceful shutdown). */
  drain: () => Promise<void>;
  /** Number of tracked promises still in flight. */
  inFlight: () => number;
};

export type HeartbeatSchedulerStep = {
  /** Stable label; it is echoed verbatim in the error log so the aborted step is named. */
  name: string;
  /** Step body. A synchronous throw is attributed to this step. */
  run: () => unknown;
  /** Await the step's result before starting the next step. Default: free-running (tracked) work. */
  await?: boolean;
  /** When the scheduler is shutting down, stop the interval before this step runs. */
  stopGate?: boolean;
};

export type HeartbeatSchedulerTickOutcome = {
  /** Steps that started without throwing, in execution order. */
  ran: string[];
  /** Steps that threw, in execution order. */
  failed: string[];
  /** True when the interval stopped early because the scheduler is shutting down. */
  stopped: boolean;
};

export const HEARTBEAT_SCHEDULER_REJECTION_MESSAGE =
  "heartbeat scheduler step failed — continuing with remaining steps";

export const createHeartbeatSchedulerWorkTracker = (options: {
  logger: HeartbeatSchedulerLogger;
  defaultStep?: string;
  /**
   * Idle-drain accounting hook. Called once per tracked promise; the returned function runs when
   * that promise settles. Keeps the interval's work visible to `idleWorkSnapshot`.
   */
  beginIdleWork?: () => () => void;
}): HeartbeatSchedulerWorkTracker => {
  const defaultStep = options.defaultStep ?? "heartbeat-scheduler-interval";
  const inFlight = new Set<Promise<void>>();

  const track = (work: unknown, step: string = defaultStep) => {
    const finishIdleWork = options.beginIdleWork?.();
    let tracked: Promise<void>;
    tracked = Promise.resolve(work)
      .then(() => undefined, (err: unknown) => {
        // This handler used to discard the rejection. It is the reason a throw in the scheduler
        // interval produced no log line at all.
        options.logger.error(
          { err, step },
          "heartbeat scheduler work rejected — logged instead of being discarded",
        );
      })
      .finally(() => {
        inFlight.delete(tracked);
        finishIdleWork?.();
      });
    inFlight.add(tracked);
  };

  const drain = async () => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  };

  return { track, drain, inFlight: () => inFlight.size };
};

/**
 * Runs one scheduler interval. Never rejects: a throwing step is logged with its own name and the
 * remaining steps still run, so the routine tick cannot be starved by an unrelated failure.
 */
export const runHeartbeatSchedulerSteps = async (
  steps: readonly HeartbeatSchedulerStep[],
  deps: {
    logger: HeartbeatSchedulerLogger;
    track: (work: unknown, step?: string) => void;
    isStopped?: () => boolean;
  },
): Promise<HeartbeatSchedulerTickOutcome> => {
  const ran: string[] = [];
  const failed: string[] = [];

  for (const step of steps) {
    if (step.stopGate && deps.isStopped?.()) {
      return { ran, failed, stopped: true };
    }
    try {
      const result = step.run();
      if (step.await) {
        await result;
      } else {
        deps.track(result, step.name);
      }
      ran.push(step.name);
    } catch (err) {
      failed.push(step.name);
      deps.logger.error({ err, step: step.name }, HEARTBEAT_SCHEDULER_REJECTION_MESSAGE);
    }
  }

  return { ran, failed, stopped: false };
};

/**
 * Bounds optional work that must never hold the scheduler.
 *
 * The routine tick is the only driver of the routine scheduler: the delivery-work worker cannot
 * start the next run until the current one returns. Optional decoration on the tick (for example the
 * metrics aggregate behind the heartbeat line) is therefore bounded rather than awaited without a
 * limit. Resolves `{ timedOut: true }` once `timeoutMs` passes; rejects only if the work itself
 * rejects before the bound.
 */
export const boundSchedulerWork = async <T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ value: T } | { timedOut: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([work.then((value) => ({ value })), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Keeps at most one instance of optional scheduler work in flight.
 *
 * A bounded wait stops the tick from *waiting* on slow work, but it does not stop the work. Without
 * this, every tick would start another query against the same pool while the previous one is still
 * running, and the pile-up would be what delays routine runs. Callers that time out keep sharing the
 * pending attempt, and the next call starts a fresh attempt only after the previous one settles.
 */
export const createSchedulerSingleFlight = <T>(start: () => Promise<T>) => {
  let inFlight: Promise<T> | null = null;

  const run = (): Promise<T> => {
    if (inFlight) return inFlight;
    const pending = start();
    inFlight = pending;
    // Handle both outcomes here so a late rejection is never unhandled, and clear the slot.
    pending.then(
      () => { if (inFlight === pending) inFlight = null; },
      () => { if (inFlight === pending) inFlight = null; },
    );
    return pending;
  };

  return { run, pending: () => inFlight !== null };
};
