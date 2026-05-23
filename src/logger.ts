/** Verbosity levels for SMTP client logging. */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export default class Logger {
  private readonly prefix: string

  constructor(
    private readonly level: LogLevel = LogLevel.INFO,
    prefix: string,
  ) {
    this.prefix = prefix
  }

  isEnabled(level: LogLevel): boolean {
    return this.level <= level
  }

  debug(message: string, ...args: any[]): void {
    if (this.isEnabled(LogLevel.DEBUG)) {
      console.debug(this.prefix + message, ...args)
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.isEnabled(LogLevel.INFO)) {
      console.info(this.prefix + message, ...args)
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.isEnabled(LogLevel.WARN)) {
      console.warn(this.prefix + message, ...args)
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.isEnabled(LogLevel.ERROR)) {
      console.error(this.prefix + message, ...args)
    }
  }
}
