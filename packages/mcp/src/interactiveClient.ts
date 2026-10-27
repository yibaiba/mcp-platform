import { randomUUID } from 'node:crypto';
import type { Client, ElicitResult, ElicitRequestParams } from '@modelcontextprotocol/client';
import { executeTool, type McpToolResult } from './operations.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
type Boundary = ReturnType<typeof deferred<McpToolResult>>;
type Pending = {
  boundary: Boundary;
  abort: AbortController;
  token?: string;
  question?: string;
  answer?: ReturnType<typeof deferred<ElicitResult>>;
};

/** Legacy reverse requests lack a portable parent request ID: serialize only this upstream session. */
export class InteractiveClient {
  private active?: Pending;
  private previous: Promise<void> = Promise.resolve();
  constructor(
    private readonly client: Client,
    enabled = true,
  ) {
    if (enabled)
      client.setRequestHandler('elicitation/create', (request, context) =>
        this.elicit(request.params, context.mcpReq.signal),
      );
  }
  call(input: Parameters<typeof executeTool>[1]): Promise<McpToolResult> {
    if (this.client.getProtocolEra() === 'modern') return executeTool(this.client, input);
    return input.requestState ? this.resume(input) : this.start(input);
  }
  cancel(token: string) {
    const state = this.active;
    if (!state) return { cancelled: false };
    if (state.token !== token) throw new Error('交互取消状态不匹配');
    const error = new Error('交互已取消');
    state.abort.abort(error);
    state.answer?.reject(error);
    return { cancelled: true };
  }
  private async start(input: Parameters<typeof executeTool>[1]) {
    const previous = this.previous;
    const finished = deferred<void>();
    this.previous = finished.promise;
    await previous;
    if (input.signal?.aborted) {
      finished.resolve();
      input.signal.throwIfAborted();
    }
    const state: Pending = { boundary: deferred<McpToolResult>(), abort: new AbortController() };
    this.active = state;
    const signal = AbortSignal.any([state.abort.signal, ...(input.signal ? [input.signal] : [])]);
    void executeTool(this.client, { ...input, signal })
      .then(
        (result) => state.boundary.resolve(result),
        (error: unknown) => state.boundary.reject(error),
      )
      .finally(() => {
        if (this.active === state) this.active = undefined;
        finished.resolve();
      });
    return this.wait(state, input.signal);
  }
  private resume(input: Parameters<typeof executeTool>[1]) {
    const state = this.active;
    const response = state?.question && input.inputResponses?.[state.question];
    if (!state || state.token !== input.requestState || !state.answer || !response)
      throw new Error('旧协议交互已结束或续传状态不匹配');
    state.token = undefined;
    state.boundary = deferred<McpToolResult>();
    state.answer.resolve(response as ElicitResult);
    state.answer = undefined;
    return this.wait(state, input.signal);
  }
  private async wait(state: Pending, signal?: AbortSignal) {
    const abort = () => {
      state.abort.abort(signal?.reason);
      state.answer?.reject(signal?.reason);
      state.boundary.reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await state.boundary.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private elicit(params: ElicitRequestParams, signal: AbortSignal) {
    const state = this.active;
    if (!state || state.answer) throw new Error('无法关联上游交互请求');
    const question = randomUUID();
    state.question = question;
    state.token = randomUUID();
    state.answer = deferred<ElicitResult>();
    state.boundary.resolve({
      resultType: 'input_required',
      requestState: state.token,
      inputRequests: { [question]: { method: 'elicitation/create', params } },
    });
    const answer = state.answer;
    const abort = () => answer.reject(signal.reason ?? new Error('上游交互中断'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return answer.promise.finally(() => signal.removeEventListener('abort', abort));
  }
}
