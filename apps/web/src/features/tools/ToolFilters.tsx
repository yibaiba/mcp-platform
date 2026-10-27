import { Search } from 'lucide-react';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { NamedFilter } from '../../components/shared/NamedFilter.js';
import type { Connection, Device, Profile } from '../../lib/api.js';
import type { ToolSearch } from './toolCatalog.js';
export function ToolFilters({
  values,
  profiles,
  connections,
  devices,
  onChange,
}: {
  values: ToolSearch;
  profiles: Profile[];
  connections: Connection[];
  devices: Device[];
  onChange: (patch: ToolSearch) => void;
}) {
  return (
    <section className="mb-5 space-y-4" aria-label="工具筛选">
      <div className="grid gap-4 md:grid-cols-3">
        <NamedFilter
          label="测试身份上下文"
          all="管理账号（全部管理权限）"
          value={values.profileId}
          options={profiles.map((profile) => ({
            id: profile.id,
            name: `${profile.name} · 实际 Agent 权限`,
          }))}
          onChange={(profileId) => onChange({ profileId, toolId: undefined })}
        />
        <NamedFilter
          label="连接"
          all="全部连接"
          value={values.connectionId}
          options={connections}
          onChange={(connectionId) => onChange({ connectionId })}
        />
        <NamedFilter
          label="执行位置"
          all="全部设备与平台主机"
          value={values.deviceId}
          options={[
            { id: 'platform', name: '平台主机（直连 / Pi）' },
            ...devices.map((device) => ({
              id: device.id,
              name: `${device.name}${device.revoked ? '（已撤销）' : device.online ? '（在线）' : '（离线）'}`,
            })),
          ]}
          onChange={(deviceId) => onChange({ deviceId })}
        />
      </div>
      <label className="search">
        <Search size={18} />
        <Input
          aria-label="搜索工具"
          placeholder="搜索工具、连接或设备名称…"
          value={values.q ?? ''}
          onChange={(event) => onChange({ q: event.target.value })}
        />
      </label>
      {values.connectionId || values.deviceId || values.q ? (
        <Button
          variant="outline"
          onClick={() => onChange({ connectionId: '', deviceId: '', q: '' })}
        >
          清除目录筛选
        </Button>
      ) : null}
    </section>
  );
}
