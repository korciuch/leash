// Preflight: launch the apps before the demo and say exactly which Automation switch is off.
import { runScript, AppleError, fixFor } from './jxa.mjs';

export const KNOWN_APPS = ['Calendar', 'Reminders', 'Mail', 'Messages'];

function checkApp(app) {
  if (!KNOWN_APPS.includes(app)) throw new TypeError(`Leash does not talk to ${app}`);
}

/**
 * Launch each app and make one cheap call, timing it.
 * @returns {Promise<{ app: string, ok: boolean, ms: number, error?: string, code?: number|null, fix?: string }[]>}
 */
export async function warmUp(apps = ['Calendar', 'Reminders', 'Mail'], { run = runScript, timeoutMs = 60000 } = {}) {
  const out = [];
  for (const app of apps) {
    checkApp(app);
    const started = Date.now();
    try {
      await run('ping', { app }, { timeoutMs, app });
      out.push({ app, ok: true, ms: Date.now() - started });
    } catch (error) {
      const e = error instanceof AppleError ? error : new AppleError({ app, message: String(error?.message || error) });
      out.push({ app, ok: false, ms: Date.now() - started, error: e.message, code: e.code, fix: e.fix });
    }
  }
  return out;
}

/**
 * Check the Automation permission for each app.
 * @returns {Promise<{ app: string, ok: boolean, code?: number|null, fix?: string, message?: string }[]>}
 */
export async function checkPermissions(apps = KNOWN_APPS, { run = runScript, timeoutMs = 30000 } = {}) {
  const out = [];
  for (const app of apps) {
    checkApp(app);
    try {
      await run('ping', { app }, { timeoutMs, app });
      out.push({ app, ok: true });
    } catch (error) {
      const code = error instanceof AppleError ? error.code : null;
      const fix = code === -1743 ? fixFor(-1743, app) : error?.fix || fixFor(code, app);
      out.push({ app, ok: false, code, fix, message: String(error?.message || error) });
    }
  }
  return out;
}

/** One line per app for logs: "Calendar ok (120 ms)" or "Mail: Turn on ...". */
export function describe(results) {
  return results.map((r) => (r.ok ? `${r.app} ok${typeof r.ms === 'number' ? ` (${r.ms} ms)` : ''}` : `${r.app}: ${r.fix || r.error || r.message}`)).join('\n');
}
