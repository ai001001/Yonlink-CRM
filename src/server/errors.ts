/**
 * 服务端业务异常定义。
 * Server-side business error definitions.
 */

/** 业务错误码 / Business error codes */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

/**
 * 可预期的业务异常，会被转换为对应 HTTP 状态。
 * Expected business error, mapped to an HTTP status.
 */
export class ApiError extends Error {
  /**
   * @param status HTTP 状态码 / HTTP status
   * @param code 错误码 / error code
   * @param message 开发者可读信息（不含敏感数据）/ developer message (no sensitive data)
   * @param details 字段级错误 / field errors
   */
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

/** 记录不存在（含跨组织访问）/ Record not found (including cross-organization access) */
export const notFound = (): ApiError => new ApiError(404, 'NOT_FOUND', 'Record not found');
