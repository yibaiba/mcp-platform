import { useState } from 'react';
import type { LibraryItem } from '@platform/contracts';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Field, Feedback } from '../../components/shared/Controls.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
type Argument = Extract<LibraryItem, { kind: 'prompt' }>['arguments'][number];
export function PromptArguments({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Only the structured editor writes this JSON; invalid advanced input stays editable.
  const rows: Argument[] = advanced ? [] : JSON.parse(value);
  const changeRow = (index: number, patch: Partial<Argument>) =>
    onChange(JSON.stringify(rows.map((row, i) => (i === index ? { ...row, ...patch } : row))));
  function toggle() {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (row) =>
            !row ||
            typeof row !== 'object' ||
            typeof row.name !== 'string' ||
            (row.description !== undefined && typeof row.description !== 'string') ||
            (row.required !== undefined && typeof row.required !== 'boolean') ||
            Object.keys(row).some((key) => !['name', 'description', 'required'].includes(key)),
        )
      )
        throw new Error('参数声明必须是包含 name、description 和 required 的对象数组。');
      setError(null);
      setAdvanced(!advanced);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
  return (
    <section className="space-y-3" aria-label="提示词参数">
      <div className="section-heading">
        <h3>参数声明</h3>
        <Button type="button" variant="ghost" onClick={toggle}>
          {advanced ? '使用参数表单' : '编辑 JSON'}
        </Button>
      </div>
      {advanced ? (
        <Field label="参数声明（JSON）">
          <Textarea
            value={value}
            rows={5}
            onChange={(e) => {
              onChange(e.target.value);
              setError(null);
            }}
          />
        </Field>
      ) : (
        <>
          {!rows.length ? (
            <p className="text-muted-foreground">尚无参数，可直接编写不含占位符的模板。</p>
          ) : null}
          {rows.map((row, index) => (
            <div className="argument-row" key={index}>
              <Field label={`参数 ${index + 1} 名称`}>
                <Input
                  value={row.name}
                  required
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  placeholder="topic"
                  onChange={(e) => changeRow(index, { name: e.target.value })}
                />
              </Field>
              <Field label={`参数 ${index + 1} 说明`}>
                <Input
                  value={row.description ?? ''}
                  onChange={(e) => changeRow(index, { description: e.target.value })}
                />
              </Field>
              <CheckChoice
                checked={row.required ?? false}
                onCheckedChange={(required) => changeRow(index, { required })}
              >
                必填
              </CheckChoice>
              <Button
                type="button"
                variant="outline"
                aria-label={`删除参数 ${index + 1}`}
                onClick={() => onChange(JSON.stringify(rows.filter((_, i) => i !== index)))}
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              onChange(JSON.stringify([...rows, { name: '', description: '', required: false }]))
            }
          >
            添加参数
          </Button>
        </>
      )}
      <Feedback error={error} />
    </section>
  );
}
