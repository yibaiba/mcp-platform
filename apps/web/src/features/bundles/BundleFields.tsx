import type { McpbManifest } from '@platform/contracts';
import { Field } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
export function BundleFields({ manifest }: { manifest: McpbManifest }) {
  return (
    <>
      {Object.entries(manifest.user_config).map(([name, rule]) => (
        <Field key={name} label={rule.title ?? name} hint={rule.description}>
          {rule.type === 'boolean' ? (
            <select name={`value:${name}`} defaultValue={String(rule.default ?? false)}>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : (
            <Input
              name={`value:${name}`}
              type={rule.sensitive ? 'password' : rule.type === 'number' ? 'number' : 'text'}
              step={rule.type === 'number' ? 'any' : undefined}
              min={rule.min}
              max={rule.max}
              required={rule.required}
              autoComplete="off"
              defaultValue={
                rule.sensitive
                  ? ''
                  : rule.multiple
                    ? JSON.stringify(rule.default ?? [])
                    : String(rule.default ?? '')
              }
              placeholder={rule.multiple ? '["/path/one", "/path/two"]' : undefined}
            />
          )}
        </Field>
      ))}
    </>
  );
}
export function bundleValues(data: FormData, manifest: McpbManifest) {
  return Object.fromEntries(
    Object.entries(manifest.user_config).flatMap(([name, rule]) => {
      const raw = String(data.get(`value:${name}`) ?? '');
      if (
        !raw ||
        (rule.default !== undefined &&
          raw ===
            (Array.isArray(rule.default) ? JSON.stringify(rule.default) : String(rule.default)))
      )
        return [];
      const value = rule.multiple
        ? JSON.parse(raw)
        : rule.type === 'boolean'
          ? raw === 'true'
          : rule.type === 'number'
            ? Number(raw)
            : raw;
      return [[name, value]];
    }),
  );
}
