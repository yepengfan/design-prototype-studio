/** An error whose message is written for the designer using the Studio. */
export class StudioError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "StudioError";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof StudioError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
