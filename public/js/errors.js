/**
 * Unified error handling for frontend feature modules.
 *
 * Why: previously each module did its own `console.error` + `toast(t(...))`
 * + optional `appendSessionLog`, with inconsistent combos. This helper keeps
 * the message template in the caller (so it stays in messages.js via t()),
 * but centralizes console logging, toast, and session-log side effects.
 */
import { toast } from './ui.js';
import { appendSessionLog } from './session-log.js';

export function errorMessage(err) {
  return err?.message || String(err);
}

/**
 * @param {Error} err
 * @param {object} opts
 * @param {string} [opts.message]  formatted message (usually from t()); defaults to err.message
 * @param {string} [opts.feature]  module tag for console + session log, e.g. "tutorial"
 * @param {boolean} [opts.notify]  show a toast (defaults false)
 * @param {boolean} [opts.log]     append to session log (defaults false)
 * @param {boolean} [opts.silent]  skip console.error (defaults false)
 * @returns {Error} the original error, for rethrow / chaining
 */
export function handleError(err, {
  message,
  feature = 'MultiLab',
  notify = false,
  log = false,
  silent = false,
} = {}) {
  if (!silent) console.error(`[${feature}]`, err);
  const msg = message ?? errorMessage(err);
  if (notify) toast(msg, true);
  if (log) appendSessionLog(`${feature}: ${msg}`, 'error');
  return err;
}
