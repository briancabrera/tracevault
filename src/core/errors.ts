/**
 * Error hierarchy used across the library.
 *
 * All errors extend `TracevaultError` so consumers can catch them in a
 * single `instanceof` check if they want.
 */

export class TracevaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TracevaultError";
  }
}

export class ConfigError extends TracevaultError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ValidationError extends TracevaultError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class DriverError extends TracevaultError {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DriverError";
    this.cause = cause;
  }
}
