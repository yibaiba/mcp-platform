import type { Profile, Tool, ContentEntry, Artifact } from '../../lib/api.js';
import { api, json, profileUpdate } from '../../lib/api.js';
import { Form } from '../../components/shared/Controls.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
export function RequestableSettings({
  profile,
  tools,
  content,
  artifacts,
}: {
  profile: Profile;
  tools: Tool[];
  content: ContentEntry[];
  artifacts: Artifact[];
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
      <p>以下能力仅能查看申请目录并申请，批准前不可执行或读取。Skill 版本始终使用长期授权。</p>
      {(
        [
          ['toolIds', tools],
          ['contentIds', content],
          ['artifactIds', artifacts],
        ] as const
      ).map(([kind, rows]) => (
        <fieldset key={kind}>
          <legend>
            {kind === 'toolIds'
              ? '工具'
              : kind === 'contentIds'
                ? 'Prompts / Resources / 模板'
                : '产物'}
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
                <small>{row.id}</small>
              </span>
            </CheckChoice>
          ))}
        </fieldset>
      ))}
    </Form>
  );
}
