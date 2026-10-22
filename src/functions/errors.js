/** Function-calling layer ki apni error type, taake HTTP status saaf map ho sake. */
export class FunctionError extends Error {
  constructor(message, code = "invalid_arguments", status = 400) {
    super(message);
    this.name = "FunctionError";
    this.code = code;
    this.status = status;
  }
}

export class DataAccessError extends Error {
  constructor(message, code = "data_unavailable", status = 503) {
    super(message);
    this.name = "DataAccessError";
    this.code = code;
    this.status = status;
  }
}
