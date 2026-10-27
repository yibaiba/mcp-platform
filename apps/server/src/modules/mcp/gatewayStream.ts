export function streamFinally(response: Response, cleanup: () => Promise<void>) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let released: Promise<void> | undefined;
  const release = () => (released ??= cleanup());
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        await release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
