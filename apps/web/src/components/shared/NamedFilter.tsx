import { Field } from './Controls.js';
import { SelectControl } from './SelectControl.js';
import { SelectItem } from '../ui/select.js';
export function NamedFilter({
  label,
  value = '',
  all,
  options,
  onChange,
  compact,
}: {
  /** Hide the visible label; the select keeps it as its accessible name. */
  compact?: boolean;
  label: string;
  value?: string;
  all: string;
  options: readonly { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  const control = (
    <SelectControl
      value={value}
      onValueChange={onChange}
      aria-label={compact ? label : undefined}
      className={compact ? 'filter-select' : undefined}
    >
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
  );
  return compact ? control : <Field label={label}>{control}</Field>;
}
