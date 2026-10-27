function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function authorizationResult(result: unknown) {
  const record = asRecord(result);
  const details = record && ('authorizationUrl' in record ? record : asRecord(record.details));
  const value = details?.authorizationUrl;
  const parsed = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined;
  const url =
    parsed && ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed
      : undefined;
  return {
    url,
    redirectUrl:
      typeof details?.redirectUrl === 'string'
        ? details.redirectUrl
        : url?.searchParams.get('redirect_uri'),
  };
}
