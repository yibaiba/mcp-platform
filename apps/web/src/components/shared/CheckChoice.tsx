import { useId, type ReactNode } from 'react';
import { Checkbox } from '../ui/checkbox.js';
import { Label } from '../ui/label.js';
export function CheckChoice({
  name,
  value,
  defaultChecked,
  disabled,
  children,
}: {
  name: string;
  value: string;
  defaultChecked?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="check-row">
      <Checkbox
        id={id}
        aria-labelledby={`${id}-label`}
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
      />
      <Label id={`${id}-label`} htmlFor={id} className="cursor-pointer font-normal">
        {children}
      </Label>
    </div>
  );
}
