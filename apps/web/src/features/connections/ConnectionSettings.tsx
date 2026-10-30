import { PackageUpdate } from '../updates/PackageUpdate.js';
import { useRef, useState } from 'react';
import type { Connection } from '../../lib/api.js';
import { api, json } from '../../lib/api.js';
import { Feedback, Field, Form, Status, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { AdvancedConnectionSettings } from './AdvancedConnectionSettings.js';
import { useQuery } from '@tanstack/react-query';
import { formatArgumentLines, parseArgumentLines } from '@platform/contracts';
import type { Device } from '../../lib/api.js';
import { ArgumentsField } from './ArgumentsField.js';
import { connectNow, type ConnectOutcome } from './connectNow.js';
import { connectionLocation, connectionNextStep } from './connectionHints.js';
import { parseJsonObject } from './jsonField.js';
import { ToolPrefixField } from './ToolPrefixField.js';
export function ConnectionSettings({
  connection,
  onSaved,
  onDirtyChange,
  lastAttempt,
}: {
  connection: Connection;
  /** Called after saving; the outcome tells whether connecting right after worked. */
  onSaved: (outcome: ConnectOutcome) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** The previous "保存并连接" in this editor failed to connect; shown with its next step. */
  lastAttempt?: ConnectOutcome;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [name, setName] = useState(connection.name);
  const advanced = useRef<HTMLDivElement>(null);
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const deviceById = new Map(devices.data?.map((device) => [device.id, device]));
  const usesUrl = connection.transport !== 'stdio' && connection.source !== 'openapi';
  const usesCommand =
    connection.transport === 'stdio' ||
    (connection.adapter === 'device' && connection.mode === 'managed');
  const initialArgs = formatArgumentLines(connection.args ?? []);
  return (
    <>
      <section className="space-y-2" aria-label="当前连接状态">
        <Status
          value={connection.deviceOffline ? 'error' : connection.status}
          label={
            connection.deviceOffline
              ? '设备离线'
              : connection.status === 'waiting_authorization'
                ? '等待账号授权'
                : undefined
          }
        />
        <p className="break-all text-sm text-muted-foreground">
          {connectionLocation(connection, deviceById)}
        </p>
        {lastAttempt?.error ? (
          <div role="alert" className="attention stacked text-sm">
            <p className="m-0 font-medium">已保存，但没有连上</p>
            <p className="m-0 break-words">{lastAttempt.error.message}</p>
            <p className="m-0">
              {connectionNextStep(connection, lastAttempt.error.message, lastAttempt.error.code)}
            </p>
          </div>
        ) : (
          <Feedback error={connection.error ? new Error(connection.error) : null} />
        )}
      </section>
      <Form
        label="保存并连接"
        onDirtyChange={onDirtyChange}
        onInvalid={(event) => {
          const input = event.target as HTMLInputElement;
          if (advancedOpen || !advanced.current?.contains(input)) return;
          event.preventDefault();
          setAdvancedOpen(true);
          requestAnimationFrame(() => {
            input.focus();
            input.reportValidity();
          });
        }}
        submit={async (data) => {
          const extra = parseJsonObject(value(data, 'patch'), '其他连接字段');
          const target: Record<string, unknown> = {};
          // Only send what changed: the shown URL has its query string stripped.
          if (usesUrl && value(data, 'url') !== (connection.url ?? ''))
            target.url = value(data, 'url');
          if (usesCommand) {
            if (value(data, 'command') !== (connection.command ?? ''))
              target.command = value(data, 'command');
            if (value(data, 'args').trim() !== initialArgs.trim())
              target.args = parseArgumentLines(value(data, 'args'));
            if (value(data, 'cwd') && value(data, 'cwd') !== (connection.cwd ?? ''))
              target.cwd = value(data, 'cwd');
          }
          await api(`/connections/${connection.id}`, {
            method: 'PATCH',
            body: json({
              ...extra,
              ...target,
              name: value(data, 'name'),
              // Empty clears it; the server then goes back to the name-derived prefix.
              toolPrefix: value(data, 'toolPrefix'),
              revision: connection.revision,
              connectTimeoutMs: Number(value(data, 'connectTimeout')) * 1000,
              requestOptions: {
                timeoutMs: Number(value(data, 'requestTimeout')) * 1000,
                resetTimeoutOnProgress: data.has('renew'),
                maxTotalTimeoutMs: value(data, 'totalTimeout')
                  ? Number(value(data, 'totalTimeout')) * 1000
                  : undefined,
              },
              identityMode: value(data, 'identityMode'),
              forwardHeaders: value(data, 'forwardHeaders')
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
              lifecycle: {
                startup: value(data, 'startup'),
                idleTimeoutMs: value(data, 'idle') ? Number(value(data, 'idle')) * 1000 : undefined,
                shutdownGraceMs: Number(value(data, 'grace')) * 1000,
              },
              health: {
                enabled: data.has('health'),
                intervalMs: Number(value(data, 'interval')) * 1000,
                timeoutMs: Number(value(data, 'timeout')) * 1000,
                recover: data.has('recover'),
                initialIntervalMs: Number(value(data, 'recoverInitial')) * 1000,
                maxIntervalMs: Number(value(data, 'recoverMax')) * 1000,
              },
            }),
          });
          onSaved(await connectNow(connection.id));
        }}
      >
        <Field label="连接名称">
          <Input
            name="name"
            defaultValue={connection.name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <ToolPrefixField
          connectionId={connection.id}
          initial={connection.toolPrefix}
          source={{
            name,
            url: connection.url,
            command: connection.command,
            args: connection.args,
          }}
        />
        {usesUrl ? (
          <Field
            label="MCP 地址"
            hint={
              connection.urlHasQuery
                ? '原地址里的查询参数已隐藏；不改这一栏会原样保留，改了会用新地址整体替换。'
                : connection.adapter === 'device'
                  ? '从那台电脑访问的地址。'
                  : undefined
            }
          >
            <Input name="url" type="url" defaultValue={connection.url} required />
          </Field>
        ) : null}
        {usesCommand ? (
          <>
            <Field
              label="启动命令"
              hint={
                connection.adapter === 'device'
                  ? '命令在所选设备上运行；该设备必须已安装程序。'
                  : '命令在平台主机上运行。'
              }
            >
              <Input name="command" defaultValue={connection.command} required />
            </Field>
            <ArgumentsField args={connection.args} />
            <Field label="工作目录（可选）">
              <Input name="cwd" defaultValue={connection.cwd} placeholder="留空使用默认目录" />
            </Field>
          </>
        ) : null}
        <Field label="上游身份">
          <SelectControl name="identityMode" defaultValue={connection.identityMode ?? 'shared'}>
            <SelectItem value="shared">继续使用连接账号</SelectItem>
            <SelectItem value="independent">
              每个接入密钥 / OAuth grant / Pi 配置独立授权
            </SelectItem>
          </SelectControl>
        </Field>
        <Disclosure title="高级设置" open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <div ref={advanced}>
            <AdvancedConnectionSettings connection={connection} />
          </div>
        </Disclosure>
      </Form>
      <Disclosure title="包版本与更新">
        <PackageUpdate id={connection.id} />
      </Disclosure>
    </>
  );
}
