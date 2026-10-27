import { NamedFilter } from '../../components/shared/NamedFilter.js';
import { Field } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import type { Connection, Device, Profile, Tool } from '../../lib/api.js';
import { callStatuses, type ActivitySearch } from './activitySearch.js';
export function ActivityFilters({
  values,
  options,
  onChange,
}: {
  values: ActivitySearch;
  options: { profiles: Profile[]; connections: Connection[]; devices: Device[]; tools: Tool[] };
  onChange: (patch: ActivitySearch) => void;
}) {
  const connectionNames = new Map(options.connections.map((item) => [item.id, item.name]));
  return (
    <section className="panel padded mb-5 space-y-4" aria-label="调用筛选">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <NamedFilter
          label="Agent"
          all="全部 Agent 与管理账号"
          value={values.profileId}
          options={options.profiles}
          onChange={(profileId) => onChange({ profileId })}
        />
        <NamedFilter
          label="连接"
          all="全部连接"
          value={values.connectionId}
          options={options.connections}
          onChange={(connectionId) => onChange({ connectionId })}
        />
        <NamedFilter
          label="执行设备"
          all="全部设备与平台主机"
          value={values.deviceId}
          options={options.devices}
          onChange={(deviceId) => onChange({ deviceId })}
        />
        <NamedFilter
          label="调用状态"
          all="全部状态"
          value={values.status}
          options={callStatuses}
          onChange={(status) => onChange({ status })}
        />
        <NamedFilter
          label="工具"
          all="全部工具"
          value={values.toolId}
          options={options.tools.map((tool) => ({
            id: tool.id,
            name: `${tool.name} · ${connectionNames.get(tool.connectionId) ?? tool.connectionId}`,
          }))}
          onChange={(toolId) => onChange({ toolId })}
        />
        <form
          key={values.taskId ?? ''}
          onSubmit={(event) => {
            event.preventDefault();
            onChange({
              taskId: String(new FormData(event.currentTarget).get('taskId') ?? '').trim(),
            });
          }}
        >
          <Field label="任务 ID（可选）">
            <div className="flex gap-2">
              <Input
                name="taskId"
                aria-label="任务 ID"
                defaultValue={values.taskId}
                pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                title="请输入完整的任务 UUID"
              />
              <Button type="submit" variant="outline">
                应用
              </Button>
            </div>
          </Field>
        </form>
      </div>
      <Button
        variant="outline"
        onClick={() =>
          onChange({
            profileId: '',
            taskId: '',
            connectionId: '',
            deviceId: '',
            toolId: '',
            status: '',
          })
        }
      >
        清除筛选
      </Button>
    </section>
  );
}
