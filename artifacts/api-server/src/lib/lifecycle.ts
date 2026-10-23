import axios from "axios";

// One process-wide stop signal. On SIGTERM: stop starting outbound requests,
// abort in-flight ones, let running jobs write their final state, and only
// then close the database pool.
const controller = new AbortController();
export const shutdownSignal: AbortSignal = controller.signal;
const tasks = new Map<Promise<unknown>, string | undefined>();

// Every axios request in this process inherits the signal unless it sets its own.
axios.defaults.signal = shutdownSignal;

export function isShuttingDown(): boolean {
  return shutdownSignal.aborted;
}

export function trackBackgroundTask<T>(task: Promise<T>, jobId?: string): Promise<T> {
  tasks.set(task, jobId);
  task.then(() => tasks.delete(task), () => tasks.delete(task));
  return task;
}

// Starts a job and tracks the WHOLE chain, including the error handler that
// writes the job's final state, so shutdown never closes the pool under it.
export function startTrackedJob(jobId: string | undefined, run: () => Promise<unknown>, onError: (error: unknown) => Promise<void>): Promise<void> {
  const task = Promise.resolve().then(run).then(() => undefined, async (error) => { await onError(error); });
  return trackBackgroundTask(task, jobId);
}

// Long jobs that learn their id after they start (the historical audit).
const activeJobs = new Set<string>();
export function markJobActive(jobId: string): () => void {
  activeJobs.add(jobId);
  return () => { activeJobs.delete(jobId); };
}

export function runningJobIds(): string[] {
  return [...new Set([...[...tasks.values()].filter((id): id is string => !!id), ...activeJobs])];
}

/** Aborts outbound work and waits up to `timeoutMs` for tracked tasks. Returns the jobs still running. */
export async function drainBackgroundTasks(timeoutMs: number): Promise<string[]> {
  if (!controller.signal.aborted) controller.abort(new Error("shutting-down"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...tasks.keys()]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return runningJobIds();
}

/** A pause that ends early on shutdown so loops reach their failure path quickly. */
export function pause(ms: number): Promise<void> {
  if (shutdownSignal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); shutdownSignal.removeEventListener("abort", done); resolve(); }
    shutdownSignal.addEventListener("abort", done, { once: true });
  });
}
