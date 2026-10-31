import { useContext, useId, useState } from 'react';
import {
  formatRawKeyValues,
  hiddenValue,
  looksSensitive,
  parseRawKeyValues,
  recordFromRows,
  rowsFromRecord,
  type KeyValueKind,
  type KeyValueRow,
} from '@platform/contracts';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Button } from '../../components/ui/button.js';
import { FormChanges } from '../../components/shared/formChanges.js';

const invalidPrefix = '!invalid:';

/**
 * Reads an editor's hidden field. Undefined means "untouched": the caller leaves the stored
 * value alone, so an existing config saves back byte for byte.
 */
export function readKeyValues(data: FormData, name: string): Record<string, string> | undefined {
  const raw = data.get(name);
  if (typeof raw !== 'string' || !raw) return undefined;
  if (raw.startsWith(invalidPrefix)) throw new Error(raw.slice(invalidPrefix.length));
  return JSON.parse(raw) as Record<string, string>;
}

const words = {
  env: { title: '环境变量', key: '变量名', placeholderKey: 'API_KEY', add: '添加变量' },
  headers: { title: '请求头', key: '名称', placeholderKey: 'Authorization', add: '添加请求头' },
} as const;

/**
 * Key-value rows for `env` or `headers`, with a raw (JSON or one-per-line) mode. Stored values
 * arrive as `hiddenValue` and are never shown; leaving one as is keeps it on save.
 */
export function KeyValueEditor({
  kind,
  name,
  initial,
  hint,
}: {
  kind: KeyValueKind;
  /** Hidden form field carrying the result (see `readKeyValues`). */
  name: string;
  /** Stored keys with masked values (edit), or undefined (create). */
  initial?: Record<string, string>;
  hint?: string;
}) {
  const id = useId();
  const changed = useContext(FormChanges);
  const w = words[kind];
  const [loaded] = useState(() => rowsFromRecord(initial));
  const loadedKeys = new Set(loaded.map((row) => row.key));
  const [rows, setRows] = useState<KeyValueRow[]>(loaded);
  const [mode, setMode] = useState<'form' | 'raw'>('form');
  const [raw, setRaw] = useState('');
  const [rawError, setRawError] = useState<string>();
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const update = (next: KeyValueRow[]) => {
    setRows(next);
    changed?.();
  };
  const checked = recordFromRows(kind, rows, loadedKeys);
  const { record } = checked;
  // A placeholder under a renamed key has no stored value to stand for.
  const problems = checked.problems.map((problem, index) =>
    !problem && rows[index]!.value === hiddenValue && !loadedKeys.has(rows[index]!.key)
      ? '改了名字的项需要重新填写值'
      : problem,
  );
  const firstProblem = problems.findIndex(Boolean);
  const untouched = JSON.stringify(rows) === JSON.stringify(loaded);
  const field =
    mode === 'raw' && rawError
      ? `${invalidPrefix}${w.title}（原始模式）：${rawError}`
      : firstProblem >= 0
        ? `${invalidPrefix}${w.title}第 ${firstProblem + 1} 行：${problems[firstProblem]}`
        : untouched
          ? ''
          : JSON.stringify(record);
  const switchMode = () => {
    if (mode === 'form') {
      setRaw(formatRawKeyValues(rows.filter((row) => row.key || row.value)));
      setRawError(undefined);
      setMode('raw');
      return;
    }
    if (rawError) return;
    setMode('form');
  };
  return (
    <fieldset className="grid gap-2" data-testid={`kv-${kind}`}>
      <legend className="text-sm font-medium">{w.title}</legend>
      {hint ? <p className="m-0 text-xs text-muted-foreground">{hint}</p> : null}
      <input type="hidden" name={name} value={field} />
      {mode === 'form' ? (
        <>
          {rows.map((row, index) => {
            const stored = row.value === hiddenValue && loadedKeys.has(row.key);
            const masked = !revealed.has(index) && looksSensitive(row.key);
            return (
              <div key={index} className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`${w.title}第 ${index + 1} 行${w.key}`}
                    aria-invalid={Boolean(problems[index])}
                    className="min-w-36 flex-1 font-mono"
                    value={row.key}
                    placeholder={w.placeholderKey}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) =>
                      update(
                        rows.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)),
                      )
                    }
                  />
                  {stored ? (
                    <span
                      className="flex h-10 min-w-36 flex-[2] items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground"
                      aria-label={`${w.title}第 ${index + 1} 行的值`}
                    >
                      ••••••（已保存，不改则保留）
                    </span>
                  ) : (
                    <Input
                      aria-label={`${w.title}第 ${index + 1} 行的值`}
                      className="min-w-36 flex-[2] font-mono"
                      type={masked ? 'password' : 'text'}
                      value={row.value}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) =>
                        update(
                          rows.map((r, i) =>
                            i === index ? { ...r, value: event.target.value } : r,
                          ),
                        )
                      }
                    />
                  )}
                  {stored ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update(rows.map((r, i) => (i === index ? { ...r, value: '' } : r)))
                      }
                    >
                      替换值
                    </Button>
                  ) : looksSensitive(row.key) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-pressed={!masked}
                      onClick={() =>
                        setRevealed((current) => {
                          const next = new Set(current);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })
                      }
                    >
                      {masked ? '显示' : '隐藏'}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`删除${w.title}第 ${index + 1} 行`}
                    onClick={() => {
                      update(rows.filter((_, i) => i !== index));
                      setRevealed(new Set());
                    }}
                  >
                    删除
                  </Button>
                </div>
                {problems[index] ? (
                  <p className="m-0 text-xs text-destructive" role="alert">
                    第 {index + 1} 行：{problems[index]}
                  </p>
                ) : null}
              </div>
            );
          })}
          {!rows.length ? (
            <p className="m-0 text-xs text-muted-foreground">还没有{w.title}。</p>
          ) : null}
        </>
      ) : (
        <>
          <Textarea
            id={`${id}-raw`}
            aria-label={`${w.title}（原始）`}
            className="font-mono"
            rows={5}
            value={raw}
            spellCheck={false}
            placeholder={
              kind === 'env'
                ? '{"API_KEY": "..."}\n或每行一个：API_KEY=...'
                : '{"Authorization": "Bearer ..."}\n或每行一个：Authorization: Bearer ...'
            }
            onChange={(event) => {
              setRaw(event.target.value);
              try {
                const parsed = parseRawKeyValues(kind, event.target.value);
                setRawError(undefined);
                setRows(parsed);
              } catch (error) {
                setRawError(error instanceof Error ? error.message : String(error));
              }
            }}
          />
          {rawError ? (
            <p className="m-0 text-xs text-destructive" role="alert">
              {rawError}
            </p>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">
              原始模式里的值是明文。已保存的值显示为「{hiddenValue}」，保留它就保留原值。
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {mode === 'form' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => update([...rows, { key: '', value: '' }])}
          >
            {w.add}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={mode === 'raw' && Boolean(rawError)}
          onClick={switchMode}
        >
          {mode === 'form' ? '切换到原始模式' : '切换回表单'}
        </Button>
      </div>
    </fieldset>
  );
}
