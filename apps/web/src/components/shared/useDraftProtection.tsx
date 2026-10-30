import { useEffect, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from './ConfirmDialog.js';

export function useDraftProtection(dirty: boolean) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  return useDiscardConfirmation({ dirty, blocker });
}

// The standalone connector page has no router; tabs and browser exits are guarded here.
export function useLocalDraftProtection(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const preventExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventExit);
    return () => window.removeEventListener('beforeunload', preventExit);
  }, [dirty]);
  return useDiscardConfirmation({ dirty });
}

function useDiscardConfirmation({
  dirty,
  blocker,
}: {
  dirty: boolean;
  blocker?: { status: string; reset?: () => void; proceed?: () => void };
}) {
  const [pending, setPending] = useState<() => void>();
  return {
    requestDiscard(action: () => void) {
      if (dirty) setPending(() => action);
      else action();
    },
    confirmation: (
      <ConfirmDialog
        open={Boolean(pending) || blocker?.status === 'blocked'}
        title="放弃未保存的修改？"
        description="当前草稿尚未保存，继续将丢失这些修改。"
        confirmLabel="放弃修改并继续"
        onOpenChange={(open) => {
          if (!open) {
            setPending(undefined);
            blocker?.reset?.();
          }
        }}
        onConfirm={() => {
          pending?.();
          setPending(undefined);
          blocker?.proceed?.();
        }}
      />
    ),
  };
}
