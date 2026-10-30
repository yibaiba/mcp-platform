import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { useState } from 'react';
function decode(value: string) {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
  );
}
function encode(text: string) {
  return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(''));
}
export function SkillEditor({
  files,
  onChange,
  readOnly,
}: {
  files: Record<string, string>;
  onChange: (files: Record<string, string>) => void;
  readOnly: boolean;
}) {
  const [path, setPath] = useState('SKILL.md');
  const [error, setError] = useState('');
  let text = '';
  let binary = false;
  try {
    text = decode(files[path] ?? '');
  } catch {
    binary = true;
  }
  return (
    <div className="local-skill">
      <label>
        文件树
        <SelectControl aria-label="文件树" value={path} onValueChange={setPath}>
          {Object.keys(files)
            .sort()
            .map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
        </SelectControl>
      </label>
      {binary ? (
        <p>二进制文件。冲突时请选择本机或平台版本，或导入替换文件。</p>
      ) : (
        <label>
          {path}
          <textarea
            rows={16}
            aria-label={path}
            spellCheck={false}
            value={text}
            readOnly={readOnly}
            onChange={(e) => onChange({ ...files, [path]: encode(e.target.value) })}
          />
        </label>
      )}
      <label>
        导入或替换文件
        <input
          type="file"
          multiple
          disabled={readOnly}
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            void Promise.all(
              chosen.map(
                async (file) =>
                  [
                    file.name,
                    btoa(
                      Array.from(new Uint8Array(await file.arrayBuffer()), (b) =>
                        String.fromCharCode(b),
                      ).join(''),
                    ),
                  ] as const,
              ),
            )
              .then((entries) => {
                onChange({ ...files, ...Object.fromEntries(entries) });
                setError('');
              })
              .catch((error: Error) => setError(error.message));
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="local-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
