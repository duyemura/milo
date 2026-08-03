/** Logger seam for learn — CLI passes console-backed loggers, admin can pass a structured emitter. */
export interface MiloLogger {
  info(msg: string): void;
  verbose(msg: string): void;
  warn(msg: string): void;
}

/** Default: milestones + warnings to console, verbose suppressed. */
export const consoleLogger: MiloLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  verbose: () => {},
};

/** Console logger with verbose lines enabled (CLI --verbose). */
export function verboseConsoleLogger(): MiloLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    verbose: (m) => console.log(m),
  };
}
