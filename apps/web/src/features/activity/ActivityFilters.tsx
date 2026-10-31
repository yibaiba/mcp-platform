import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
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
  children,
}: {
  children?: ReactNode;
  values: ActivitySearch;
  options: { profiles: Profile[]; connections: Connection[]; devices: Device[]; tools: Tool[] };
  onChange: (patch: ActivitySearch) => void;
}) {
  const connectionNames = new Map(options.connections.map((item) => [item.id, item.name]));
  const [more, setMore] = useState(() =>
    Boolean(values.from || values.before || values.deviceId || values.toolId || values.taskId),
  );
  const extra = [values.from, values.before, values.deviceId, values.toolId, values.taskId].filter(
    Boolean,
  ).length;
  const active =
    extra + [values.status, values.connectionId, values.profileId].filter(Boolean).length;
  return (
    <section className="mb-4 space-y-2" aria-label="调用筛选">
      <div className="filter-bar mb-0">
        <NamedFilter
          compact
          label="调用状态"
          all="全部状态"
          value={values.status}
          options={callStatuses}
          onChange={(status) => onChange({ status })}
        />
        <NamedFilter
          compact
          label="连接"
          all="全部连接"
          value={values.connectionId}
          options={options.connections}
          onChange={(connectionId) => onChange({ connectionId })}
        />
        <NamedFilter
          compact
          label="Agent"
          all="全部 Agent"
          value={values.profileId}
          options={options.profiles}
          onChange={(profileId) => onChange({ profileId })}
        />
        <Button variant="ghost" aria-expanded={more} onClick={() => setMore(!more)}>
          <SlidersHorizontal aria-hidden="true" />
          更多筛选{extra ? ` · ${extra}` : ''}
        </Button>
        {active ? (
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                from: '',
                before: '',
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
        ) : null}
        {children}
      </div>
      {more ? (
        <div className="grid gap-4 rounded-md border p-4 sm:grid-cols-2 xl:grid-cols-3">
          {(['from', 'before'] as const).map((field) => (
            <Field key={field} label={field === 'from' ? '起始时间' : '结束时间（不含）'}>
              <Input
                type="datetime-local"
                value={values[field] ?? ''}
                onChange={(event) => onChange({ [field]: event.target.value })}
              />
            </Field>
          ))}
          <NamedFilter
            label="运行在哪台设备"
            all="全部设备与平台服务器"
            value={values.deviceId}
            options={options.devices}
            onChange={(deviceId) => onChange({ deviceId })}
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
            <Field label="任务 ID">
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
      ) : null}
    </section>
  );
}
