// skinlab exit codes (E D9) and the error that carries one out of a command.

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2, SKIP: 77 });

export class ExitError extends Error {
  /** @param {number} code one of EXIT @param {string} message printed to stderr */
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

export const usageError = (message) => new ExitError(EXIT.USAGE, message);
export const skip = (message) => new ExitError(EXIT.SKIP, message);
export const fail = (message) => new ExitError(EXIT.FAIL, message);
