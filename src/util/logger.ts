/**
 * Minimal logger. Token is never logged (security.md §7).
 */

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string): void {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`[${level}] ${message}\n`);
}

export function info(message: string): void {
  log("info", message);
}

export function warn(message: string): void {
  log("warn", message);
}

export function error(message: string): void {
  log("error", message);
}
