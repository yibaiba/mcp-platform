export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 | 4 | 5,
  ) {
    super(message);
  }
}
