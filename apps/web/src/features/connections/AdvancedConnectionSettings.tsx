import type { Connection } from '../../lib/api.js';
import { Field } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Disclosure } from '../../components/shared/Disclosure.js';

export function AdvancedConnectionSettings({ connection }: { connection: Connection }) {
  return (
    <div className="grid gap-4">
      <Field label="启动方式">
        <SelectControl name="startup" defaultValue={connection.lifecycle?.startup ?? 'eager'}>
          <SelectItem value="eager">保持现有连接行为</SelectItem>
          <SelectItem value="on-demand">按需唤醒</SelectItem>
        </SelectControl>
      </Field>
      <div className="form-grid">
        <Field label="连接初始化超时（秒）">
          <Input
            name="connectTimeout"
            type="number"
            min="1"
            defaultValue={(connection.connectTimeoutMs ?? 60000) / 1000}
            required
          />
        </Field>
        <Field label="单次执行等待（秒）">
          <Input
            name="requestTimeout"
            type="number"
            min="1"
            defaultValue={(connection.requestOptions?.timeoutMs ?? 60000) / 1000}
            required
          />
        </Field>
        <Field
          label="最长总执行时间（秒）"
          hint="开启进度续期时必填，不能小于单次等待；等待回答不计入执行时间。"
        >
          <Input
            name="totalTimeout"
            type="number"
            min="1"
            defaultValue={
              connection.requestOptions?.maxTotalTimeoutMs
                ? connection.requestOptions.maxTotalTimeoutMs / 1000
                : ''
            }
          />
        </Field>
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
      <CheckChoice
        name="renew"
        value="true"
        defaultChecked={connection.requestOptions?.resetTimeoutOnProgress}
      >
        有效进度延长等待时间
      </CheckChoice>
      <CheckChoice name="health" value="true" defaultChecked={connection.health?.enabled}>
        启用健康检查
      </CheckChoice>
      <CheckChoice name="recover" value="true" defaultChecked={connection.health?.recover}>
        首次连接失败或断线后自动恢复连接（不重放工具）
      </CheckChoice>
      <div className="form-grid">
        <Field label="恢复初始间隔（秒）">
          <Input
            name="recoverInitial"
            type="number"
            min="1"
            defaultValue={(connection.health?.initialIntervalMs ?? 5000) / 1000}
            required
          />
        </Field>
        <Field label="恢复最大间隔（秒）" hint="失败后间隔倍增，并加入 20% 随机抖动。">
          <Input
            name="recoverMax"
            type="number"
            min="1"
            defaultValue={(connection.health?.maxIntervalMs ?? 300000) / 1000}
            required
          />
        </Field>
      </div>
      <Field
        label="动态转发请求头"
        hint="逗号分隔；平台 Cookie、Authorization 及协议控制头禁止转发。"
      >
        <Input name="forwardHeaders" defaultValue={connection.forwardHeaders?.join(', ')} />
      </Field>
      <Disclosure title="开发者选项：其他连接字段（JSON 增量）">
        <Field
          label="其他连接字段（JSON 增量）"
          hint="可选。用于 oauth 等表单没有的字段；地址、命令、参数、请求头和环境变量请用上方表单。未填写的字段保留原值。"
        >
          <Textarea name="patch" defaultValue="{}" rows={5} />
        </Field>
      </Disclosure>
    </div>
  );
}
