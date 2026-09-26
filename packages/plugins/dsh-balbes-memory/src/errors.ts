export type MemoryErrorCode =
  | "secret-detected"
  | "invalid-record"
  | "not-found"
  | "invalid-scope"
  | "invalid-filter"
  | "invalid-query";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}
