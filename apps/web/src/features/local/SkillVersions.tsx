import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { useState } from 'react';
import type { LocalResource } from '@platform/contracts';
import type { ManagementApi } from './api.js';
export function SkillVersions({
  resource,
  api,
  busy,
  act,
  onChange,
}: {
  resource: LocalResource;
  api: ManagementApi;
  busy: boolean;
  act: (work: () => Promise<unknown>) => Promise<void>;
  onChange: (files: Record<string, string>) => void;
}) {
  const [versions, setVersions] = useState<{ id: string; label: string }[]>();
  const [version, setVersion] = useState('');
  if (!api.versions || !api.version || resource.readOnly) return null;
  return (
    <details className="local-conflict">
      <summary>切换内容版本</summary>
      <p>将历史内容载入编辑器，检查后保存。Agent 已固定的版本授权保持不变。</p>
      <button
        disabled={busy}
        onClick={() => void act(async () => setVersions(await api.versions!(resource)))}
      >
        读取历史版本
      </button>
      {versions ? (
        versions.length ? (
          <>
            <label>
              内容版本
              <SelectControl aria-label="内容版本" value={version} onValueChange={setVersion}>
                <SelectItem value="">选择版本</SelectItem>
                {versions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectControl>
            </label>
            <button
              disabled={busy || !version}
              onClick={() => void act(async () => onChange(await api.version!(version)))}
            >
              载入编辑器
            </button>
          </>
        ) : (
          <p>暂无历史版本。</p>
        )
      ) : null}
    </details>
  );
}
