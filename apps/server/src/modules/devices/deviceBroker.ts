import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { randomUUID } from 'node:crypto';
import {
  deviceResponse,
  CALL_TIMEOUT_MS,
  HEARTBEAT_MS,
  type DeviceRequest,
  type DeviceResponse,
} from '@platform/contracts';
import type { WebSocket } from 'ws';
import { AppError } from '../../shared/errors.js';
import { z } from 'zod';
import type { McpNotification, Progress } from '@platform/mcp';
const progressSchema = z.object({
  progress: z.number(),
  total: z.number().optional(),
  message: z.string().optional(),
});

type Pending = {
  deviceId: string;
  socket: WebSocket;
  finish: (value: unknown, error?: Error) => void;
  onprogress?: (progress: Progress) => void;
};
export class DeviceBroker {
  private readonly generations = new Map<string, string>();
  generation(id: string) {
    return this.generations.get(id) ?? 'offline';
  }
  private readonly localListeners = new Set<(id: string) => void>();
  watchLocal(listener: (id: string) => void) {
    this.localListeners.add(listener);
    return () => this.localListeners.delete(listener);
  }
  private readonly capabilities = new Map<string, readonly string[]>();
  hasCapability(id: string, capability: string) {
    return this.capabilities.get(id)?.includes(capability) ?? false;
  }
  requireCapability(id: string, capability: string) {
    if (!this.hasCapability(id, capability))
      throw new AppError('CONNECTOR_UPGRADE', `设备连接器需要升级以支持 ${capability}`, 409);
  }
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(event: McpNotification) => void>>();
  constructor(
    private readonly report: (id: string, message: DeviceResponse) => Promise<void>,
    private readonly logger: DiagnosticLogger,
  ) {}
  diagnostic(code: string) {
    this.logger.report(code);
  }
  online(id: string) {
    return this.sockets.get(id)?.readyState === 1;
  }
  attach(id: string, socket: WebSocket) {
    this.disconnect(id);
    this.sockets.set(id, socket);
    this.generations.set(id, randomUUID());
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', (data) => {
      void this.receive(id, socket, data.toString()).catch((error: unknown) => {
        this.logger.report(
          error instanceof SyntaxError
            ? 'DEVICE_INVALID_JSON'
            : error instanceof z.ZodError
              ? 'DEVICE_INVALID_MESSAGE'
              : 'DEVICE_MESSAGE_FAILED',
        );
        socket.close(1008, 'Invalid device message');
      });
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(heartbeat);
      // An older socket may close after its replacement has already authenticated.
      if (this.sockets.get(id) === socket) {
        this.sockets.delete(id);
        this.generations.delete(id);
        this.capabilities.delete(id);
      }
      for (const request of this.pending.values()) {
        if (request.socket === socket)
          request.finish(
            undefined,
            new AppError(
              'RESULT_UNKNOWN',
              '设备连接中断；操作可能已执行，请检查设备后再决定是否重试',
              503,
            ),
          );
      }
    });
  }
  private async receive(id: string, socket: WebSocket, raw: string) {
    if (this.sockets.get(id) !== socket) return;
    const message = deviceResponse.parse(JSON.parse(raw));
    if (message.type === 'local.changed') this.generations.set(id, randomUUID());
    if (message.type === 'hello') {
      this.capabilities.set(id, message.capabilities ?? []);
      if (this.hasCapability(id, 'local-sync'))
        for (const listener of this.localListeners) listener(id);
    }
    if (message.type === 'local.changed') {
      this.requireCapability(id, 'local-sync');
      for (const listener of this.localListeners) listener(id);
      return;
    }
    if (message.type === 'notification') {
      if (message.method === 'notifications/progress') {
        const pending = message.requestId ? this.pending.get(message.requestId) : undefined;
        if (pending?.socket === socket) pending.onprogress?.(progressSchema.parse(message.params));
      } else {
        for (const listener of this.listeners.get(
          `${id}:${message.connectionId}:${message.sessionId ?? ''}`,
        ) ?? [])
          listener({ method: message.method, params: message.params });
      }
      return;
    }
    if (message.type !== 'result') return this.report(id, message);
    const pending = this.pending.get(message.id);
    if (!pending || pending.socket !== socket) return;
    pending.finish(
      message.result,
      message.error ? new AppError(message.error.code, message.error.message, 502) : undefined,
    );
  }
  request(
    deviceId: string,
    input: {
      method: DeviceRequest['method'];
      params: Record<string, unknown>;
      signal?: AbortSignal;
      onprogress?: (progress: Progress) => void;
      executionTimeoutMs?: number;
    },
  ) {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== 1)
      return Promise.reject(new AppError('DEVICE_OFFLINE', '设备离线，无法执行', 503));
    if (input.signal?.aborted)
      return Promise.reject(new AppError('CANCELLED', '请求已取消；设备执行状态需确认', 409));
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        socket.send(JSON.stringify({ v: 1, type: 'cancel', id }));
        finish(
          undefined,
          new AppError('RESULT_UNKNOWN', '已请求取消或达到截止时间；请确认设备执行结果', 409),
        );
      };
      const timeoutMs = input.executionTimeoutMs ?? CALL_TIMEOUT_MS;
      const deadlineAt = Date.now() + timeoutMs;
      // This deadline is the remaining platform budget, not a separate 60s cap.
      const timer = setTimeout(cancel, timeoutMs);
      const finish = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', cancel);
        this.pending.delete(id);
        // Older connectors can report their deadline before the platform timer runs.
        if (error && Date.now() >= deadlineAt)
          reject(new AppError('RESULT_UNKNOWN', '设备截止时间已到；请确认上游执行结果', 502));
        else if (error) reject(error);
        else resolve(value);
      };
      this.pending.set(id, { deviceId, socket, finish, onprogress: input.onprogress });
      input.signal?.addEventListener('abort', cancel, { once: true });
      const request: DeviceRequest = {
        v: 1,
        type: 'request',
        id,
        method: input.method,
        params: { ...input.params, ...(input.onprogress ? { progressToken: id } : {}) },
        deadline: new Date(deadlineAt).toISOString(),
      };
      socket.send(JSON.stringify(request), (error) => {
        if (error)
          finish(undefined, new AppError('RESULT_UNKNOWN', '设备发送失败；执行结果未知', 503));
      });
    });
  }
  disconnect(id: string) {
    this.sockets.get(id)?.terminate();
    this.sockets.delete(id);
    this.generations.delete(id);
    this.capabilities.delete(id);
  }
  watch(input: {
    deviceId: string;
    connectionId: string;
    sessionId?: string;
    listener: (event: McpNotification) => void;
  }) {
    const key = `${input.deviceId}:${input.connectionId}:${input.sessionId ?? ''}`;
    const listeners = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, listeners);
    listeners.add(input.listener);
    return () => {
      listeners.delete(input.listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
  close() {
    for (const id of this.sockets.keys()) this.disconnect(id);
  }
}
