import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { useState } from 'react';
import { api, json, type Profile, type Tool } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Action, Code, Field, Form, value } from '../../components/shared/Controls.js';
export function DiscoveryEditor({
  profile,
  tools,
  close,
}: {
  profile: Profile;
  tools: Tool[];
  close: () => void;
}) {
  const [inspection, setInspection] = useState<unknown>();
  const [strategy, setStrategy] = useState(profile.searchOptions.strategy);
  const [mode, setMode] = useState(profile.discoveryMode);
  const [footprint, setFootprint] = useState<unknown>();
  return (
    <div className="grid gap-4">
      <Form
        label="保存发现配置"
        submit={async (data) => {
          await api(`/profiles/${profile.id}`, {
            method: 'PUT',
            body: json({
              ...profile,
              id: undefined,
              ownerId: undefined,
              createdAt: undefined,
              deploymentState: undefined,
              discoveryMode: mode,
              resultPresentation: {
                enabled: data.get('excerpt') === 'on',
                thresholdBytes: Number(value(data, 'thresholdBytes')),
                retainBytes: Number(value(data, 'retainBytes')),
                strategy: value(data, 'resultStrategy'),
              },
              searchOptions:
                mode === 'search'
                  ? {
                      strategy,
                      minScore:
                        value(data, 'minScore') === '' ? null : Number(value(data, 'minScore')),
                      hnsw: {
                        m: Number(value(data, 'hnswM')),
                        efConstruction: Number(value(data, 'efConstruction')),
                        efSearch: Number(value(data, 'efSearch')),
                      },
                    }
                  : profile.searchOptions,
              pinnedTools: data.getAll('pinnedTool'),
              embedding:
                mode === 'search'
                  ? {
                      baseUrl: value(data, 'baseUrl'),
                      model: value(data, 'model'),
                      apiKeyRef: value(data, 'apiKeyRef') || undefined,
                      dimensions: value(data, 'dimensions')
                        ? Number(value(data, 'dimensions'))
                        : undefined,
                      timeoutMs: Number(value(data, 'timeoutMs')),
                      batchSize: Number(value(data, 'batchSize')),
                    }
                  : profile.embedding,
            }),
          });
          close();
        }}
      >
        <Field label="发现方式">
          <SelectControl
            value={mode}
            onValueChange={(value) => setMode(value as Profile['discoveryMode'])}
          >
            <SelectItem value="direct">直接目录</SelectItem>
            <SelectItem value="search">语义搜索</SelectItem>
          </SelectControl>
        </Field>
        {mode === 'search' ? (
          <>
            <Field
              label="检索策略"
              hint="HNSW 是近似检索，可能返回更少结果；启用后请为各调用身份显式重建索引。"
            >
              <SelectControl
                value={strategy}
                onValueChange={(value) => setStrategy(value as typeof strategy)}
              >
                <SelectItem value="exact">精确余弦检索</SelectItem>
                <SelectItem value="hnsw">HNSW 近似检索（最多 2000 维）</SelectItem>
              </SelectControl>
            </Field>
            <Field
              label="最低相似度"
              hint="范围 -1 到 1；留空表示不过滤。没有达到阈值的工具时返回空结果。"
            >
              <Input
                name="minScore"
                type="number"
                min="-1"
                max="1"
                step="any"
                defaultValue={profile.searchOptions.minScore ?? ''}
              />
            </Field>
            <details>
              <summary>HNSW 参数</summary>
              <Field label="邻居数量 m">
                <Input
                  name="hnswM"
                  type="number"
                  min="2"
                  max="100"
                  required
                  defaultValue={profile.searchOptions.hnsw.m}
                />
              </Field>
              <Field label="构建候选数量 efConstruction">
                <Input
                  name="efConstruction"
                  type="number"
                  min="4"
                  max="1000"
                  required
                  defaultValue={profile.searchOptions.hnsw.efConstruction}
                />
              </Field>
              <Field label="查询候选数量 efSearch">
                <Input
                  name="efSearch"
                  type="number"
                  min="1"
                  max="1000"
                  required
                  defaultValue={profile.searchOptions.hnsw.efSearch}
                />
              </Field>
            </details>
            <Field
              label="Embedding API 地址"
              hint="OpenAI 兼容地址，例如 https://服务地址/v1；可以使用本地服务。"
            >
              <Input name="baseUrl" type="url" required defaultValue={profile.embedding?.baseUrl} />
            </Field>
            <Field label="Embedding 模型">
              <Input name="model" required defaultValue={profile.embedding?.model} />
            </Field>
            <Field
              label="API 密钥引用"
              hint="在配置模板页面保存个人秘密后填写名称；无认证的本地服务可留空。"
            >
              <Input name="apiKeyRef" defaultValue={profile.embedding?.apiKeyRef} />
            </Field>
            <Field label="向量维度（可选）">
              <Input
                name="dimensions"
                type="number"
                min="1"
                defaultValue={profile.embedding?.dimensions}
              />
            </Field>
            <Field label="请求超时（毫秒）">
              <Input
                name="timeoutMs"
                type="number"
                min="1"
                required
                defaultValue={profile.embedding?.timeoutMs ?? 60000}
              />
            </Field>
            <Field label="每批定义数量">
              <Input
                name="batchSize"
                type="number"
                min="1"
                required
                defaultValue={profile.embedding?.batchSize ?? 64}
              />
            </Field>
          </>
        ) : null}
        <fieldset>
          <legend>长结果展示</legend>
          <CheckChoice
            name="excerpt"
            value="on"
            defaultChecked={profile.resultPresentation.enabled}
          >
            启用明确节选并保存完整原文
          </CheckChoice>
          <p>
            成功结果的普通文本超过阈值时按各块长度分配预算，使用所选策略节选并标明省略。完整结果以
            JSON
            产物保存，会增加磁盘占用；读取仍需原调用身份及当前工具权限。结构化内容、媒体、错误与
            Apps 结果保持完整。
          </p>
          <Field
            label="节选策略"
            hint="自动识别失败时使用普通文本；指定策略不匹配时保留原文并说明。"
          >
            <SelectControl
              name="resultStrategy"
              defaultValue={profile.resultPresentation.strategy ?? 'head-tail'}
            >
              <SelectItem value="head-tail">保留头尾（默认）</SelectItem>
              <SelectItem value="auto">自动识别</SelectItem>
              <SelectItem value="json">JSON 样本</SelectItem>
              <SelectItem value="log">日志与错误上下文</SelectItem>
              <SelectItem value="search">搜索文件分组</SelectItem>
              <SelectItem value="diff">文件修改块</SelectItem>
              <SelectItem value="text">普通文本</SelectItem>
            </SelectControl>
          </Field>
          <Field label="触发阈值（字节）">
            <Input
              name="thresholdBytes"
              type="number"
              min="1"
              required
              defaultValue={profile.resultPresentation.thresholdBytes}
            />
          </Field>
          <Field
            label="保留原文字节总数"
            hint="省略标记和原文读取说明额外显示。关闭后新调用恢复完整返回，已有原文仍遵循产物权限规则。"
          >
            <Input
              name="retainBytes"
              type="number"
              min="1"
              required
              defaultValue={profile.resultPresentation.retainBytes}
            />
          </Field>
        </fieldset>
        <fieldset>
          <legend>始终展示的授权工具</legend>
          {tools
            .filter((tool) => profile.toolIds.includes(tool.id))
            .map((tool) => (
              <CheckChoice
                key={tool.id}
                name="pinnedTool"
                value={tool.id}
                defaultChecked={profile.pinnedTools.includes(tool.id)}
              >
                {profile.catalog.tools[tool.id]?.alias ?? tool.name}
              </CheckChoice>
            ))}
        </fieldset>
      </Form>
      {profile.discoveryMode === 'search' ? (
        <>
          <p>
            以下操作使用已保存配置及当前管理身份，不执行业务工具。Agent 凭据拥有独立索引作用域。
          </p>
          <Action
            action={async () => setInspection(await api(`/profiles/${profile.id}/search-index`))}
          >
            检查索引
          </Action>
          <Action
            action={async () =>
              setInspection(
                await api(`/profiles/${profile.id}/search-index/rebuild`, { method: 'POST' }),
              )
            }
          >
            重建当前身份索引
          </Action>
          <Form
            label="测试已保存检索配置"
            submit={async (data) =>
              setInspection(
                await api(`/profiles/${profile.id}/search-test`, {
                  method: 'POST',
                  body: json({ query: value(data, 'query'), limit: Number(value(data, 'limit')) }),
                }),
              )
            }
          >
            <Field label="测试查询">
              <Input name="query" required />
            </Field>
            <Field label="最多结果数">
              <Input name="limit" type="number" min="1" defaultValue="10" required />
            </Field>
          </Form>
          {inspection ? <Code value={inspection} /> : null}
        </>
      ) : null}
      <Button type="button" variant="outline" onClick={close}>
        关闭
      </Button>
      <Action
        action={async () => setFootprint(await api(`/profiles/${profile.id}/context-footprint`))}
      >
        估算已保存配置的 Token
      </Action>
      <p>使用本地 o200k_base 编码估算最终工具定义，展示完整目录与当前暴露量，不代表模型账单。</p>
      {footprint ? <Code value={footprint} /> : null}
    </div>
  );
}
