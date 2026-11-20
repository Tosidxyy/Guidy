export class ApiError extends Error {
  code: string; status: number; diagnosticId?: string; details?: unknown;
  constructor(code: string, status: number, message: string, diagnosticId?: string, details?: unknown) {
    super(message); this.code = code; this.status = status; this.diagnosticId = diagnosticId; this.details = details;
  }
}