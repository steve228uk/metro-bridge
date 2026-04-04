export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(name: string): Logger {
  const prefix = `[metro-bridge:${name}]`;
  return {
    info: (msg, ...args) => console.error(prefix, msg, ...args),
    warn: (msg, ...args) => console.error(prefix, 'WARN:', msg, ...args),
    error: (msg, ...args) => console.error(prefix, 'ERROR:', msg, ...args),
    debug: (msg, ...args) => {
      if (process.env.DEBUG) {
        console.error(prefix, 'DEBUG:', msg, ...args);
      }
    },
  };
}
