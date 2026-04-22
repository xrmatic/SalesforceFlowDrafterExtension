// Logger utility – memory-bounded, levelled logging for the extension.
// All log entries are kept in a ring-buffer capped at MAX_ENTRIES so we
// never accumulate unbounded memory in a long-lived session.

const MAX_ENTRIES = 500;

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  constructor(prefix = 'SF Flow Drafter') {
    this.prefix = prefix;
    this._entries = [];
    this._minLevel = LEVELS.debug;
  }

  setMinLevel(level) {
    if (level in LEVELS) this._minLevel = LEVELS[level];
  }

  _record(level, args) {
    if (LEVELS[level] < this._minLevel) return;

    const message = args
      .map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'object' && a !== null) {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      })
      .join(' ');

    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
    };

    this._entries.push(entry);
    // Ring-buffer: drop oldest when over capacity
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.splice(0, this._entries.length - MAX_ENTRIES);
    }

    const fn =
      level === 'error' ? console.error :
      level === 'warn'  ? console.warn  :
      level === 'debug' ? console.debug :
                          console.log;
    fn(`[${this.prefix}][${level.toUpperCase()}] ${message}`);
  }

  debug(...args) { this._record('debug', args); }
  info(...args)  { this._record('info',  args); }
  warn(...args)  { this._record('warn',  args); }
  error(...args) { this._record('error', args); }

  /** Return a copy of stored entries, optionally filtered by level. */
  getEntries(level = null) {
    if (level) return this._entries.filter(e => e.level === level);
    return [...this._entries];
  }

  /** Serialise entries as a timestamped text block for display/download. */
  dump() {
    return this._entries
      .map(e => `${e.ts} [${e.level.toUpperCase()}] ${e.message}`)
      .join('\n');
  }

  clear() { this._entries = []; }
}

// Singleton used across all modules
export const log = new Logger();
