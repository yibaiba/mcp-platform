function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function authorizationResult(result: unknown) {
  const record = asRecord(result);
  const details = record && (asRecord(record.details) ?? record);
  const value = details?.authorizationUrl;
  const parsed = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined;
  const url =
    parsed && ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed
      : undefined;
  return {
    url,
    authorized:
      record?.status === 'AUTHORIZED' ||
      details?.authenticated === true ||
      details?.authorized === true,
    pending: record?.status === 'REDIRECT' || details?.pending === true,
    redirectUrl:
      typeof record?.redirectUrl === 'string'
        ? record.redirectUrl
        : url?.searchParams.get('redirect_uri'),
  };
}
