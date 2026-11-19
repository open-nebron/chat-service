export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ForbiddenError extends AppError {
  constructor(code: string = 'forbidden', message: string = 'Forbidden') {
    super(code, message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(code: string = 'not_found', message: string = 'Not found') {
    super(code, message, 404);
    this.name = 'NotFoundError';
  }
}
