import { execSync } from 'node:child_process';

/**
 * Bring the postgres container up before any tests run, and tear it back
 * down (`docker compose down`, which stops *and* removes it) once all tests
 * finish — but only if the test run is what started it. If the developer
 * already had the container running before invoking vitest, leave it alone
 * so we don't yank state out from under an interactive psql session or a
 * parallel tool. Watch mode benefits from the same logic: the container
 * starts when watch begins and goes away when watch exits.
 *
 * Two teardown paths are wired up. Vitest invokes the returned function on
 * its normal exit path, but its own SIGINT/SIGTERM handler calls
 * `process.exit()` ~1ms after the signal — bypassing globalSetup teardown.
 * To keep Ctrl+C from leaking the container we also register `exit` /
 * `SIGINT` / `SIGTERM` listeners on the Node process that run docker-down
 * synchronously. Both paths converge on a single idempotent helper so we
 * never `docker compose down` twice.
 *
 * Hard kills (SIGKILL) still bypass everything — nothing in Node can
 * prevent that.
 */
function isContainerRunning(): boolean {
  try {
    const out = execSync('docker compose ps -q postgres', { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export default function globalSetup(): () => void {
  // Capture pre-run state *before* `up --wait` so we know whether the test
  // run is responsible for starting the container.
  const wasRunningBeforeTests = isContainerRunning();
  // `up -d --wait` is idempotent: a no-op when already up and healthy, blocks
  // until ready otherwise. Always run it so a stopped or unhealthy container
  // doesn't quietly send tests at a backend that isn't accepting queries yet.
  execSync('docker compose up -d --wait', { stdio: 'inherit' });

  let tornDown = false;
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    if (wasRunningBeforeTests) return;
    try {
      execSync('docker compose down', { stdio: 'inherit' });
    } catch (err) {
      console.error('[globalTeardown] docker compose down failed:', err);
    }
  };

  // Signal handlers cover the Ctrl+C path. Vitest registers its own SIGINT
  // handler that fires `process.exit()` ~1ms later — we run synchronously
  // first so docker-down completes before the event loop gets cut.
  // execSync blocks the event loop, so vitest's setTimeout can't preempt it.
  const onSignal = (signal: NodeJS.Signals): void => {
    teardown();
    // 128 + signal number matches Node's default-exit semantics for caught
    // signals (e.g. SIGINT → 130). Without this, hanging on a signal we
    // caught would leak the process if vitest's handler hasn't registered.
    const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    process.exit(process.exitCode ?? code);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // `exit` covers the clean-run path and any code path that reaches
  // process.exit without going through a signal. Synchronous execSync runs
  // before the process actually terminates.
  process.once('exit', teardown);

  return teardown;
}
