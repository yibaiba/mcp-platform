import { PageHeader } from '../../components/shared/PageHeader.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Card } from '../../components/ui/card.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json, type Skill, type Profile, type Device } from '../../lib/api.js';
import {
  Code,
  date,
  Empty,
  Feedback,
  Field,
  Form,
  value,
} from '../../components/shared/Controls.js';
export default function SkillsPage() {
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<Skill[]>('/skills') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const [selected, setSelected] = useState<Skill>();
  const [result, setResult] = useState<unknown>();
  return (
    <>
      <PageHeader title="Skills" />
      <Feedback error={skills.error ?? profiles.error ?? devices.error} />
      <div className="overview-grid">
        <Card className="panel padded">
          <h2>导入 Skill 包</h2>
          <Form
            label="导入 ZIP"
            submit={async (data) => {
              const file = data.get('package');
              if (!(file instanceof File)) throw new Error('请选择 ZIP 文件');
              setResult(
                await api('/skills/zip', {
                  method: 'POST',
                  body: file,
                  headers: { 'Content-Type': 'application/zip' },
                }),
              );
            }}
          >
            <Field label="ZIP 文件" hint="根目录包含 SKILL.md；导入不会执行脚本">
              <Input name="package" type="file" accept=".zip" required />
            </Field>
          </Form>
          <Disclosure title="从 Git 固定版本导入">
            <Form
              label="导入 Git 版本"
              submit={async (data) =>
                setResult(
                  await api('/skills/git', {
                    method: 'POST',
                    body: json({
                      url: value(data, 'url'),
                      revision: value(data, 'revision'),
                      path: value(data, 'path'),
                      dependencies: value(data, 'dependencies')
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    }),
                  }),
                )
              }
            >
              <Field label="HTTPS 仓库地址">
                <Input name="url" type="url" required />
              </Field>
              <Field label="Commit SHA（40 位）">
                <Input name="revision" pattern="[a-f0-9]{40}" required />
              </Field>
              <Field label="Skill 子目录">
                <Input name="path" placeholder="skills/example" />
              </Field>
              <Field label="MCP 工具依赖 ID（逗号分隔）">
                <Input name="dependencies" />
              </Field>
            </Form>
          </Disclosure>
        </Card>
        <Card className="panel padded">
          <h2>分发 / 回滚到指定版本</h2>
          <Form
            label="安装所选版本"
            submit={async (data) =>
              setResult(
                await api(`/skills/${value(data, 'versionId')}/install`, {
                  method: 'POST',
                  body: json({
                    profileId: value(data, 'profileId'),
                    deviceId: value(data, 'deviceId'),
                    target: value(data, 'target'),
                  }),
                }),
              )
            }
          >
            <Field label="版本">
              <SelectControl
                name="versionId"
                required
                value={selected?.id ?? ''}
                onValueChange={(id) => setSelected(skills.data?.find((s) => s.id === id))}
              >
                <SelectItem value="">选择版本</SelectItem>
                {skills.data?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {s.digest.slice(0, 10)}
                  </SelectItem>
                ))}
              </SelectControl>
            </Field>
            <Field label="Agent 配置">
              <SelectControl name="profileId" required>
                <SelectItem value="">选择配置</SelectItem>
                {profiles.data?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectControl>
            </Field>
            <Field label="安装设备">
              <SelectControl name="deviceId" required>
                <SelectItem value="">选择设备</SelectItem>
                {devices.data
                  ?.filter((d) => !d.revoked)
                  .map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
              </SelectControl>
            </Field>
            <Field
              label="设备本地 Skill 根目录名称"
              hint="在 connector.json 的 skillRoots 中配置，例如 claude-user"
            >
              <Input name="target" defaultValue="claude-user" required />
            </Field>
          </Form>
          <small>
            本地文件被修改时保留原文件并报告冲突。安装成功后须重新加载客户端，并验证 Skill
            是否生效。
          </small>
        </Card>
      </div>
      <Card className="panel">
        <div className="panel-heading">
          <h2>版本库</h2>
        </div>
        {skills.data?.length ? (
          skills.data.map((skill) => (
            <div className="row" key={skill.id}>
              <div className="grow">
                <strong>{skill.name}</strong>
                <small>
                  {skill.digest.slice(0, 12)} · {date(skill.createdAt)} ·{' '}
                  {skill.dependencies.length} 个依赖
                </small>
              </div>
              <a href={`/api/v1/skills/${skill.id}/export`}>导出包</a>
              <Button onClick={() => setSelected(skill)}>选择版本</Button>
            </div>
          ))
        ) : (
          <Empty>尚未导入 Skill。</Empty>
        )}
      </Card>
      {result ? <Code value={result} /> : null}
    </>
  );
}
