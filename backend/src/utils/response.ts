import { Response, Request } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
  requestId?: string;
}

export function sendSuccess<T>(res: Response, data: T, statusCode: number = 200): Response {
  const req = res.req as Request;
  const requestId = (req as any)?.id || (res.getHeader('X-Request-Id') as string) || undefined;

  const payload: ApiResponse<T> = {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    ...(requestId ? { requestId } : {})
  };

  return res.status(statusCode).json(payload);
}

export function sendError(
  res: Response,
  message: string,
  statusCode: number = 500,
  code: string = 'INTERNAL_ERROR',
  details: any = null
): Response {
  const req = res.req as Request;
  const requestId = (req as any)?.id || (res.getHeader('X-Request-Id') as string) || undefined;

  const payload: ApiResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    },
    timestamp: new Date().toISOString(),
    ...(requestId ? { requestId } : {})
  };

  return res.status(statusCode).json(payload);
}
