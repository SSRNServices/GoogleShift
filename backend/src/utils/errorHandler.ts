import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { sendError } from './response';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
}

export function globalErrorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_SERVER_ERROR';
  const requestId = (req as any).id || res.getHeader('X-Request-Id');

  logger.error(`[Unhandled Exception] ${err.message}`, {
    requestId,
    statusCode,
    code,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const message = isProduction && statusCode === 500
    ? 'An internal server error occurred. Please contact support.'
    : err.message || 'Internal server error';

  const details = isProduction ? null : err.details || null;

  sendError(res, message, statusCode, code, details);
}
