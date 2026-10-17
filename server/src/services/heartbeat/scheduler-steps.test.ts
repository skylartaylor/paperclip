import { describe, expect, it, vi } from "vitest";
import {
  boundSchedulerWork,
  createHeartbeatSchedulerWorkTracker,
  createSchedulerSingleFlight,
  runHeartbeatSchedulerSteps,
  type HeartbeatSchedulerStep,
} from "./scheduler-steps.js";

/**
 * Regression tests for the heartbeat-scheduler interval.
 *
 * Colocated with the module they exercise, per the heartbeat execution-boundaries rule: only
 * assembled-service tests belong in `server/src/__tests__/`.
 *
 * The failure mode these lock down is the silent routine-scheduler stall: the interval body ran
 * inside `Promise.resolve(work).then(() => undefined, () => undefined)`, so a throw in any step
 * between the timer tick and the routine tick discarded the rejection. No log line, no metric, no
 * HTTP symptom — timer ticks kept firing on the interval while the routine scheduler stayed dead
 * for 44 minutes.
 */

const createLogger = () => ({
  error: vi.fn<(obj: Record<string, unknown>, msg: string) => void>(),
});

const errorCalls = (logger: ReturnType<typeof createLogger>) => logger.error.mock.calls;

describe("heartbeat scheduler interval", () => {
  it("logs one error naming the throwing step and still runs the routine tick", async () => {
    const logger = createLogger();
    const tracker = createHeartbeatSchedulerWorkTracker({ logger });
    const order: string[] = [];
    const routineTick = vi.fn(async () => {
      order.push("routine-tick");
    });

    // Mirrors the production order: timer tick, then a step that throws, then the routine tick.
    const steps: HeartbeatSchedulerStep[] = [
      { name: "issue-monitor-timer-tick", run: () => order.push("timer-tick") },
      {
        name: "external-object-refresh-sweep",
        run: () => {
          throw new Error("injected sweep failure");
        },
      },
      { name: "routine-scheduler-tick", run: routineTick },
    ];

    const outcome = await runHeartbeatSchedulerSteps(steps, {
      logger,
      track: tracker.track,
      isStopped: () => false,
    });

    // The throwing step is named in exactly one error line, and the interval did not abort.
    expect(errorCalls(logger)).toHaveLength(1);
    expect(errorCalls(logger)[0]?.[0]).toMatchObject({ step: "external-object-refresh-sweep" });
    expect(String(errorCalls(logger)[0]?.[0]?.err)).toContain("injected sweep failure");
    expect(outcome.failed).toEqual(["external-object-refresh-sweep"]);
    expect(outcome.ran).toEqual(["issue-monitor-timer-tick", "routine-scheduler-tick"]);
    expect(routineTick).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["timer-tick", "routine-tick"]);
  });

  it("logs one error per interval for a step that throws on every tick", async () => {
    const logger = createLogger();
    const tracker = createHeartbeatSchedulerWorkTracker({ logger });
    const routineTick = vi.fn(async () => undefined);
    const steps: HeartbeatSchedulerStep[] = [
      { name: "issue-monitor-timer-tick", run: () => undefined },
      {
        name: "decision-retention-sweep",
        run: async () => {
          throw new Error("retention sweep exploded");
        },
        await: true,
      },
      { name: "routine-scheduler-tick", run: routineTick },
    ];

    for (let interval = 0; interval < 3; interval += 1) {
      await runHeartbeatSchedulerSteps(steps, { logger, track: tracker.track, isStopped: () => false });
    }

    expect(errorCalls(logger)).toHaveLength(3);
    for (const [payload, message] of errorCalls(logger)) {
      expect(payload).toMatchObject({ step: "decision-retention-sweep" });
      expect(String(message)).toContain("continuing with remaining steps");
    }
    expect(routineTick).toHaveBeenCalledTimes(3);
  });

  it("never discards a rejected fire-and-forget step", async () => {
    const logger = createLogger();
    const tracker = createHeartbeatSchedulerWorkTracker({ logger });
    const rejecting = Promise.reject(new Error("routine scheduler tick failed"));

    tracker.track(rejecting, "routine-scheduler-tick");
    await tracker.drain();

    expect(errorCalls(logger)).toHaveLength(1);
    expect(errorCalls(logger)[0]?.[0]).toMatchObject({ step: "routine-scheduler-tick" });
    expect(String(errorCalls(logger)[0]?.[1])).toContain("logged instead of being discarded");
    expect(tracker.inFlight()).toBe(0);
  });

  it("releases idle-drain accounting for every tracked promise", async () => {
    const logger = createLogger();
    const finishes: Array<ReturnType<typeof vi.fn>> = [];
    const tracker = createHeartbeatSchedulerWorkTracker({
      logger,
      beginIdleWork: () => {
        const finish = vi.fn();
        finishes.push(finish);
        return finish;
      },
    });

    tracker.track(Promise.resolve("ok"));
    tracker.track(Promise.reject(new Error("rejected work")));
    await tracker.drain();

    expect(finishes).toHaveLength(2);
    for (const finish of finishes) expect(finish).toHaveBeenCalledTimes(1);
    expect(tracker.inFlight()).toBe(0);
  });

  it("stops the interval at a shutdown gate without logging a failure", async () => {
    const logger = createLogger();
    const tracker = createHeartbeatSchedulerWorkTracker({ logger });
    const routineTick = vi.fn(async () => undefined);
    const steps: HeartbeatSchedulerStep[] = [
      { name: "issue-monitor-timer-tick", run: () => undefined, stopGate: true },
      { name: "routine-scheduler-tick", run: routineTick, stopGate: true },
    ];

    const outcome = await runHeartbeatSchedulerSteps(steps, {
      logger,
      track: tracker.track,
      isStopped: () => true,
    });

    expect(outcome.stopped).toBe(true);
    expect(outcome.ran).toEqual([]);
    expect(routineTick).not.toHaveBeenCalled();
    expect(errorCalls(logger)).toHaveLength(0);
  });
});

describe("heartbeat scheduler optional work", () => {
  it("stops waiting for optional work at the bound instead of holding the tick", async () => {
    const never = new Promise<string>(() => {});
    const started = Date.now();
    const outcome = await boundSchedulerWork(never, 20);

    expect(outcome).toEqual({ timedOut: true });
    // The bound is what keeps a slow aggregate from delaying the next routine run.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns the value when the work settles inside the bound", async () => {
    await expect(boundSchedulerWork(Promise.resolve(7), 1_000)).resolves.toEqual({ value: 7 });
  });

  it("still reports a failure that happens before the bound", async () => {
    await expect(boundSchedulerWork(Promise.reject(new Error("metrics exploded")), 1_000)).rejects.toThrow(
      "metrics exploded",
    );
  });
});

describe("heartbeat scheduler single-flight optional work", () => {
  it("starts one attempt while the previous one is still pending", async () => {
    let started = 0;
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const single = createSchedulerSingleFlight(async () => {
      started += 1;
      return gate;
    });

    const first = single.run();
    const second = single.run();
    expect(started).toBe(1);

    // A tick that timed out keeps sharing the pending attempt, so repeated ticks cannot pile up.
    const timedOut = await boundSchedulerWork(single.run(), 10);
    expect(timedOut).toEqual({ timedOut: true });
    expect(started).toBe(1);
    expect(single.pending()).toBe(true);

    release("done");
    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");
    expect(single.pending()).toBe(false);

    // Once it settles, the next tick starts a fresh attempt.
    single.run();
    expect(started).toBe(2);
  });

  it("clears the slot after a failed attempt and does not raise an unhandled rejection", async () => {
    let started = 0;
    const single = createSchedulerSingleFlight(async () => {
      started += 1;
      throw new Error("metrics exploded");
    });

    await expect(single.run()).rejects.toThrow("metrics exploded");
    await Promise.resolve();
    expect(single.pending()).toBe(false);
    await expect(single.run()).rejects.toThrow("metrics exploded");
    expect(started).toBe(2);
  });
});
