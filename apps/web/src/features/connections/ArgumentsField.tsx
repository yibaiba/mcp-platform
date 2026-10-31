import { Field } from '../../components/shared/Controls.js';
import { Textarea } from '../../components/ui/textarea.js';
import { formatArgumentLines, hiddenArgument } from '@platform/contracts';

/** "One argument per line" instead of a JSON array; a pasted JSON array still works. */
export function ArgumentsField({ args }: { args?: readonly string[] }) {
  const hidden = args?.includes(hiddenArgument);
  return (
    <Field
      label="参数（每行一个）"
      hint={
        hidden
          ? `每行一个参数，含空格的参数也只占一行。「${hiddenArgument}」是已保存的敏感值，保持在原来的行即可不变。`
          : '每行一个参数，含空格的参数也只占一行；也可以直接粘贴 JSON 数组。'
      }
    >
      <Textarea
        name="args"
        rows={Math.min(8, Math.max(3, (args?.length ?? 0) + 1))}
        defaultValue={formatArgumentLines(args ?? [])}
        placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/me/Documents'}
        spellCheck={false}
      />
    </Field>
  );
}
