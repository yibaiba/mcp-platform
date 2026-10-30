import type { ReactNode } from 'react';
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
  children,
}: {
  children?: ReactNode;
  values: ToolSearch;
  profiles: Profile[];
  connections: Connection[];
  devices: Device[];
  onChange: (patch: ToolSearch) => void;
}) {
  const filtered = Boolean(values.connectionId || values.deviceId || values.q);
  return (
    <section className="filter-bar" aria-label="工具筛选">
      <NamedFilter
        compact
        label="测试身份"
        all="管理账号"
        value={values.profileId}
        options={profiles}
        onChange={(profileId) => onChange({ profileId, toolId: undefined })}
      />
      <NamedFilter
        compact
        label="连接"
        all="全部连接"
        value={values.connectionId}
        options={connections}
        onChange={(connectionId) => onChange({ connectionId })}
      />
      <NamedFilter
        compact
        label="执行位置"
        all="全部位置"
        value={values.deviceId}
        options={[
          { id: 'platform', name: '平台主机' },
          ...devices.map((device) => ({
            id: device.id,
            name: `${device.name}${device.revoked ? '（已撤销）' : device.online ? '' : '（离线）'}`,
          })),
        ]}
        onChange={(deviceId) => onChange({ deviceId })}
      />
      <div className="search-field">
        <Search size={14} aria-hidden="true" />
        <Input
          type="search"
          aria-label="搜索工具"
          placeholder="搜索工具"
          value={values.q ?? ''}
          onChange={(event) => onChange({ q: event.target.value })}
        />
      </div>
      {filtered ? (
        <Button variant="ghost" onClick={() => onChange({ connectionId: '', deviceId: '', q: '' })}>
          清除筛选
        </Button>
      ) : null}
      {children}
    </section>
  );
}
