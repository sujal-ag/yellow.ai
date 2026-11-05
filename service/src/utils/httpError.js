// An error that carries an HTTP status. Throw it from controllers or services;
// the error middleware turns it into a JSON response.

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
