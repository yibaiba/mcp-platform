import type { Profile, Tool, ContentEntry, Artifact } from '../../lib/api.js';
import { api, json, profileUpdate } from '../../lib/api.js';
import { Form } from '../../components/shared/Controls.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
export function RequestableSettings({
  profile,
  tools,
  content,
  artifacts,
  connectionName,
}: {
  profile: Profile;
  tools: Tool[];
  content: ContentEntry[];
  artifacts: Artifact[];
  /** Readable source shown under each tool/content row instead of its hash id. */
  connectionName: (id: string) => string;
}) {
  return (
    <Form
      label="保存可申请范围"
      submit={(data) =>
        api(`/profiles/${profile.id}`, {
          method: 'PUT',
          body: json(
            profileUpdate(profile, {
              requestable: {
                toolIds: data.getAll('toolIds').map(String),
                contentIds: data.getAll('contentIds').map(String),
                artifactIds: data.getAll('artifactIds').map(String),
              },
            }),
          ),
        })
      }
    >
      <p>以下能力 Agent 只能看到并申请，批准前不能执行或读取。Skill 版本始终使用长期授权。</p>
      {(
        [
          ['toolIds', tools],
          ['contentIds', content],
          ['artifactIds', artifacts],
        ] as const
      ).map(([kind, rows]) => (
        <fieldset key={kind}>
          <legend>
            {kind === 'toolIds' ? '工具' : kind === 'contentIds' ? '提示词、资源与模板' : '文件'}
          </legend>
          {rows.map((row) => (
            <CheckChoice
              key={row.id}
              name={kind}
              value={row.id}
              defaultChecked={profile.requestable[kind].includes(row.id)}
            >
              <span>
                {row.name}
                {'connectionId' in row ? <small>{connectionName(row.connectionId)}</small> : null}
              </span>
            </CheckChoice>
          ))}
        </fieldset>
      ))}
    </Form>
  );
}
