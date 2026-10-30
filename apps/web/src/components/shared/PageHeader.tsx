import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { InfoTip } from './InfoTip.js';

type Slots = { title: HTMLElement | null; actions: HTMLElement | null };
const PageHeaderSlots = createContext<Slots>({ title: null, actions: null });

/** Shell owns the topbar; pages fill its title and primary-action slots through this provider. */
export function PageHeaderProvider({ children }: { children: (bind: Binders) => ReactNode }) {
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <PageHeaderSlots.Provider value={{ title, actions }}>
      {children({ title: setTitle, actions: setActions })}
    </PageHeaderSlots.Provider>
  );
}
type Binders = {
  title: (node: HTMLElement | null) => void;
  actions: (node: HTMLElement | null) => void;
};

/**
 * Page title (rendered as the only h1, in the topbar) plus at most one primary action.
 * `info` holds an optional short explanation behind an ⓘ tooltip.
 */
export function PageHeader({
  title,
  info,
  badge,
  actions,
}: {
  title: ReactNode;
  info?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  const slots = useContext(PageHeaderSlots);
  return (
    <>
      {slots.title
        ? createPortal(
            <div className="page-title">
              <h1>{title}</h1>
              {badge}
              {info ? <InfoTip>{info}</InfoTip> : null}
            </div>,
            slots.title,
          )
        : null}
      {slots.actions && actions ? createPortal(actions, slots.actions) : null}
    </>
  );
}
