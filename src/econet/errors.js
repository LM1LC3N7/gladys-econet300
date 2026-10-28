// -----------------------------------------------------------------------------
// The errors of the transport and of the module, as codes. A message never
// carries an address, a user name, a password or an answer of the module.
// -----------------------------------------------------------------------------

export const CODES = {
  /** No connection, or the connection dropped. */
  UNREACHABLE: 'unreachable',
  /** No complete answer in time. */
  TIMEOUT: 'timeout',
  /** The answer was larger than allowed: dropped before the end. */
  TOO_LARGE: 'tooLarge',
  /** Cut on purpose (a stop takes the connection). */
  ABORTED: 'aborted',
  /** A command could not leave in time: nothing written. */
  LATE: 'late',
  /** An HTTP status other than 200. */
  HTTP: 'http',
  /** An answer that is not the expected JSON. */
  BAD_ANSWER: 'badAnswer',
  /** A write answered without "result": "OK". */
  NOT_OK: 'notOk',
};

export class EconetError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {{ sent?: boolean, status?: number, result?: string }} [details]
   *   `sent`: the request was written (it may have reached the module)
   */
  constructor(code, { sent = false, status, result } = {}) {
    super(status === undefined ? code : `${code} ${status}`);
    this.name = 'EconetError';
    this.code = code;
    this.sent = sent;
    this.status = status;
    this.result = result;
  }
}

/** The local user or password refused by the module. */
export const isAuthRefused = (err) =>
  err?.code === CODES.HTTP && (err.status === 401 || err.status === 403);

/** The module asks to slow down (429) or fails (5xx). */
export const isBusy = (err) =>
  err?.code === CODES.HTTP && (err.status === 429 || (err.status >= 500 && err.status <= 599));

/** A short reason for the logs and the texts (never a secret). */
export function reasonOf(err) {
  if (!(err instanceof EconetError)) {
    return 'error';
  }
  if (err.code === CODES.HTTP) {
    return `HTTP ${err.status}`;
  }
  return err.code;
}
