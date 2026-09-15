import type { ProtocolErrorCode } from "@bobing/protocol";

export class AppError extends Error {
  constructor(public readonly code: ProtocolErrorCode, message: string, public readonly status = 400, public readonly details?: unknown) {
    super(message);
  }
}

export const asPublicError = (error: unknown) => error instanceof AppError
  ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
  : { code: "PERSISTENCE_FAILED" as const, message: "服务器暂时无法完成操作" };
