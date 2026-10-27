import type { Connection } from '../../lib/api.js';
import { api, json } from '../../lib/api.js';
import { Field, Form, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
export function ConnectionSettings({
  connection,
  onSaved,
}: {
  connection: Connection;
  onSaved: () => void;
}) {
  return (
    <Form
      label="保存设置"
      submit={async (data) => {
        const extra = JSON.parse(value(data, 'patch') || '{}') as Record<string, unknown>;
        await api(`/connections/${connection.id}`, {
          method: 'PATCH',
          body: json({
            ...extra,
            name: value(data, 'name'),
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
          <SelectItem value="independent">每个接入密钥 / OAuth grant / Pi 配置独立授权</SelectItem>
        </SelectControl>
      </Field>
      <Field label="启动方式">
        <SelectControl name="startup" defaultValue={connection.lifecycle?.startup ?? 'eager'}>
          <SelectItem value="eager">保持现有连接行为</SelectItem>
          <SelectItem value="on-demand">按需唤醒</SelectItem>
        </SelectControl>
      </Field>
      <div className="form-grid">
        <Field label="闲置休眠（秒，留空关闭）">
          <Input
            name="idle"
            type="number"
            min="1"
            defaultValue={
              connection.lifecycle?.idleTimeoutMs ? connection.lifecycle.idleTimeoutMs / 1000 : ''
            }
          />
        </Field>
        <Field label="进程退出宽限期（秒）">
          <Input
            name="grace"
            type="number"
            min="0"
            defaultValue={(connection.lifecycle?.shutdownGraceMs ?? 5000) / 1000}
            required
          />
        </Field>
        <Field label="健康检查间隔（秒）">
          <Input
            name="interval"
            type="number"
            min="1"
            defaultValue={(connection.health?.intervalMs ?? 60000) / 1000}
            required
          />
        </Field>
        <Field label="探测超时（秒）">
          <Input
            name="timeout"
            type="number"
            min="1"
            defaultValue={(connection.health?.timeoutMs ?? 5000) / 1000}
            required
          />
        </Field>
      </div>
      <CheckChoice name="health" value="true" defaultChecked={connection.health?.enabled}>
        启用健康检查
      </CheckChoice>
      <CheckChoice name="recover" value="true" defaultChecked={connection.health?.recover}>
        健康检查失败后恢复连接（不重放工具）
      </CheckChoice>
      <Field
        label="动态转发请求头"
        hint="逗号分隔；平台 Cookie、Authorization 及协议控制头禁止转发。"
      >
        <Input name="forwardHeaders" defaultValue={connection.forwardHeaders?.join(', ')} />
      </Field>
      <Field
        label="其他连接字段（JSON 增量）"
        hint="可更新 url、command、args、env、headers、oauth 等；未填写的字段保留原值。"
      >
        <Textarea name="patch" defaultValue="{}" rows={5} />
      </Field>
    </Form>
  );
}
