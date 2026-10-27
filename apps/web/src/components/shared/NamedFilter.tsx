import { Field } from './Controls.js';
import { SelectControl } from './SelectControl.js';
import { SelectItem } from '../ui/select.js';
export function NamedFilter({
  label,
  value = '',
  all,
  options,
  onChange,
}: {
  label: string;
  value?: string;
  all: string;
  options: readonly { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <SelectControl value={value} onValueChange={onChange}>
        <SelectItem value="">{all}</SelectItem>
        {value && !options.some((option) => option.id === value) ? (
          <SelectItem value={value}>当前筛选：{value}</SelectItem>
        ) : null}
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectControl>
    </Field>
  );
}
