import { Monitor, Moon, Sun } from 'lucide-react';
import { setThemePreference, useThemePreference } from '../../lib/theme.js';

const options = [
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;

/** Compact theme switch for the standalone local page, which has no account menu. */
export function LocalThemeSwitch() {
  const preference = useThemePreference();
  return (
    <div className="local-theme" role="group" aria-label="外观">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={preference === value}
          onClick={() => setThemePreference(value)}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
