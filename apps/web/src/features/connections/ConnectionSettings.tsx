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
export function ConnectionSettings({
  connection,
  onSaved,
  onDirtyChange,
}: {
  connection: Connection;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advanced = useRef<HTMLDivElement>(null);
  return (
    <>
      <section className="space-y-2" aria-label="当前连接状态">
        <Status
          value={connection.status}
          label={connection.status === 'waiting_authorization' ? '等待账号授权' : undefined}
        />
        {connection.url ? (
          <p className="break-all text-sm text-muted-foreground">{connection.url}</p>
        ) : null}
        <Feedback error={connection.error ? new Error(connection.error) : null} />
      </section>
      <Form
        label="保存设置"
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
          const extra = JSON.parse(value(data, 'patch') || '{}') as Record<string, unknown>;
          await api(`/connections/${connection.id}`, {
            method: 'PATCH',
            body: json({
              ...extra,
              name: value(data, 'name'),
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
          onSaved();
        }}
      >
        <Field label="连接名称">
          <Input name="name" defaultValue={connection.name} required />
        </Field>
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
