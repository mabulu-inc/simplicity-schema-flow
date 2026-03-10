export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  color?: boolean;
}

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

function formatMessage(level: LogLevel, message: string, color: boolean): string {
  const prefixes: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: color ? `${COLORS.gray}debug${COLORS.reset}` : 'debug',
    [LogLevel.INFO]: color ? `${COLORS.blue}info${COLORS.reset}` : 'info',
    [LogLevel.WARN]: color ? `${COLORS.yellow}warn${COLORS.reset}` : 'warn',
    [LogLevel.ERROR]: color ? `${COLORS.red}error${COLORS.reset}` : 'error',
  };
  return `${prefixes[level]}  ${message}`;
}

function formatJson(level: LogLevel, message: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
  });
}

export function createLogger(options: LoggerOptions): Logger {
  const { verbose, quiet, json } = options;
  const useColor = options.color ?? true;
  const writeOut = options.stdout ?? ((msg: string) => process.stdout.write(msg + '\n'));
  const writeErr = options.stderr ?? ((msg: string) => process.stderr.write(msg + '\n'));

  function log(level: LogLevel, message: string): void {
    const isError = level === LogLevel.ERROR;
    const isWarn = level === LogLevel.WARN;
    const isDebug = level === LogLevel.DEBUG;

    // Quiet mode: only errors
    if (quiet && !isError) return;

    // Debug only in verbose mode
    if (isDebug && !verbose) return;

    const formatted = json ? formatJson(level, message) : formatMessage(level, message, useColor);

    if (isError || isWarn) {
      writeErr(formatted);
    } else {
      writeOut(formatted);
    }
  }

  return {
    debug: (message: string) => log(LogLevel.DEBUG, message),
    info: (message: string) => log(LogLevel.INFO, message),
    warn: (message: string) => log(LogLevel.WARN, message),
    error: (message: string) => log(LogLevel.ERROR, message),
  };
}
