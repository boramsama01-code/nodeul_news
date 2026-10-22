import { AsyncLocalStorage } from "node:async_hooks";
import { warnSource } from "./crawlRuntime";

const GOOGLE_REQUEST_INTERVAL_MS = 1500;
type UnavailableStatus = 429 | 503;

export interface GoogleRssPolicyClock {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
}

interface PolicyState {
  tail: Promise<void>;
  nextStartAt: number;
  unavailableStatus?: UnavailableStatus;
  warnedRanges: Set<string>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  warn: (message: string) => void;
}

const policyContext = new AsyncLocalStorage<PolicyState>();

export class GoogleRssCircuitOpenError extends Error {
  constructor(public readonly status: UnavailableStatus, public readonly range: string) {
    super(`${range}: HTTP ${status} 응답으로 이 작업의 남은 구글뉴스 검색을 생략합니다. 해당 기간의 구글뉴스 수집은 미완료이며 직접 RSS와 다른 수집 경로는 계속 진행합니다.`);
    this.name = "GoogleRssCircuitOpenError";
  }
}

// Includes rss-parser's plain "Status code 503" errors and HTTP client errors.
function unavailableStatus(error: unknown): UnavailableStatus | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {status?: unknown; statusCode?: unknown; response?: {status?: unknown}; message?: unknown};
  const status = Number(value.response?.status ?? value.statusCode ?? value.status);
  if (status === 429 || status === 503) return status;
  const match = typeof value.message === "string"
    ? value.message.match(/\b(?:status(?:\s+code)?|HTTP)\s*[:=]?\s*(429|503)\b/i)
    : null;
  return match ? Number(match[1]) as UnavailableStatus : undefined;
}

export function withGoogleRssPolicy<T>(run: () => T, clock: GoogleRssPolicyClock = {}): T {
  return policyContext.run({
    tail: Promise.resolve(), nextStartAt: 0, warnedRanges: new Set(),
    now: clock.now ?? Date.now,
    sleep: clock.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    warn: clock.warn ?? (message => warnSource("구글뉴스 RSS", message)),
  }, run);
}

// Pass the existing bounded retry operation as load. Only a final failure opens
// the circuit. Direct RSS must not call this function, including its cache load.
export function requestGoogleRss<T>(
  startDate: string,
  endDate: string,
  load: () => Promise<T>,
): Promise<T> {
  const state = policyContext.getStore();
  if (!state) return Promise.resolve().then(load);
  const range = `${startDate}~${endDate}`;
  const stopped = (status: UnavailableStatus): GoogleRssCircuitOpenError => {
    const error = new GoogleRssCircuitOpenError(status, range);
    if (!state.warnedRanges.has(range)) {
      state.warnedRanges.add(range);
      state.warn(error.message);
    }
    return error;
  };
  const pending = state.tail.then(async () => {
    if (state.unavailableStatus) throw stopped(state.unavailableStatus);
    const wait = state.nextStartAt - state.now();
    if (wait > 0) await state.sleep(wait);
    state.nextStartAt = state.now() + GOOGLE_REQUEST_INTERVAL_MS;
    try {
      return await load();
    } catch (error) {
      const status = unavailableStatus(error);
      if (status) {
        state.unavailableStatus = status;
        throw stopped(status);
      }
      throw error;
    }
  });
  // Failure releases the queue so pending work can observe the open circuit.
  state.tail = pending.then(() => undefined, () => undefined);
  return pending;
}
