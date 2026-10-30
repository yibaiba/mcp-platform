import { Children, isValidElement, useContext, type ReactNode } from 'react';
import { FormChanges } from './formChanges.js';
import { Select, SelectContent, SelectTrigger, SelectValue } from '../ui/select.js';
type SelectControlProps = {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  required?: boolean;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  'aria-describedby'?: string;
  'aria-label'?: string;
  className?: string;
};
export function SelectControl({
  id,
  children,
  onValueChange,
  'aria-describedby': description,
  'aria-label': label,
  className,
  ...props
}: SelectControlProps) {
  const changed = useContext(FormChanges);
  const items = Children.toArray(children)
    .filter(isValidElement<{ value: string; children: ReactNode }>)
    .map((item) => ({ value: item.props.value, label: item.props.children }));
  return (
    <Select
      items={items}
      {...props}
      onValueChange={(value) => {
        if (value !== null) onValueChange?.(value);
        changed?.();
      }}
    >
      <SelectTrigger
        id={id}
        aria-describedby={description}
        aria-label={label}
        className={className ?? 'w-full'}
      >
        <SelectValue>
          {(value: string | null) => items.find((item) => item.value === value)?.label ?? '请选择'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
