/**
 * An error whose message is meant for the agent/user as-is (no stack trace,
 * no "internal error" framing). Tool handlers render these as tool errors.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
