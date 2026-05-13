import {
  runProgressMessageProvider,
  type RunProgressEventProvider,
} from "./oracle/v18/run_progress.js";

export interface HeartbeatRunProgressConfig {
  readonly provider: RunProgressEventProvider;
  /**
   * Defaults to true when present. Set false to leave the prose heartbeat
   * untouched while keeping one config object around.
   */
  readonly enabled?: boolean;
}

export interface HeartbeatConfig {
  intervalMs?: number;
  log: (message: string) => void;
  isActive: () => boolean;
  makeMessage: (elapsedMs: number) => Promise<string | null> | string | null;
  /**
   * Optional v18 structured progress provider. When enabled and the provider
   * returns an event, the heartbeat emits that run_progress.v1 JSON line.
   * If it returns null, the normal prose makeMessage fallback still runs.
   */
  runProgress?: HeartbeatRunProgressConfig;
}

/**
 * Compose multiple makeMessage providers into one. Each provider is
 * invoked in order; the first non-null result wins. Useful for
 * layering a `run_progress.v1` emitter on top of an existing
 * heartbeat without modifying the caller's code paths.
 *
 * Additive helper — does not affect `startHeartbeat` behavior; callers
 * that don't use it see identical semantics.
 */
export function composeHeartbeatMessages(
  ...providers: ReadonlyArray<HeartbeatConfig["makeMessage"]>
): HeartbeatConfig["makeMessage"] {
  return async (elapsedMs: number) => {
    for (const provider of providers) {
      const result = await provider(elapsedMs);
      if (result != null) return result;
    }
    return null;
  };
}

export function startHeartbeat(config: HeartbeatConfig): () => void {
  const { intervalMs, log, isActive } = config;
  if (!intervalMs || intervalMs <= 0) {
    return () => {};
  }
  const makeMessage =
    config.runProgress && config.runProgress.enabled !== false
      ? composeHeartbeatMessages(
          runProgressMessageProvider(config.runProgress.provider),
          config.makeMessage,
        )
      : config.makeMessage;
  let stopped = false;
  let pending = false;
  const start = Date.now();
  const timer = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    let active = false;
    try {
      active = isActive();
    } catch {
      stop();
      return;
    }
    if (!active) {
      stop();
      return;
    }
    pending = true;
    try {
      const elapsed = Date.now() - start;
      const message = await makeMessage(elapsed);
      if (message && !stopped) {
        log(message);
      }
    } catch {
      // ignore heartbeat errors
    } finally {
      pending = false;
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
