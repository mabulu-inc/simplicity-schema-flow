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
 * Hard kills of the vitest process (SIGKILL) bypass teardown — nothing in
 * Node can prevent that. For the normal exit paths (clean run, failing
 * tests, Ctrl+C, vitest exiting watch) this fires reliably.
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

  return () => {
    if (wasRunningBeforeTests) return;
    try {
      execSync('docker compose down', { stdio: 'inherit' });
    } catch (err) {
      console.error('[globalTeardown] docker compose down failed:', err);
    }
  };
}
