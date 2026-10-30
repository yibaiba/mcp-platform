import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Hint } from '../ui/tooltip.js';

/** ⓘ icon that reveals a short explanation (≤ 40 字) on hover or focus. */
export function InfoTip({ children, label = '说明' }: { children: ReactNode; label?: string }) {
  return (
    <Hint content={children}>
      <button type="button" className="info-tip" aria-label={label}>
        <Info size={14} aria-hidden="true" />
      </button>
    </Hint>
  );
}
