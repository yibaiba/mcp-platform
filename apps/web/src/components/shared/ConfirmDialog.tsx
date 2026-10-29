import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog.js';
export type Confirmation = { title: string; description: string; confirmLabel?: string };
export function ConfirmDialog({
  title,
  description,
  confirmLabel = '确认',
  open,
  onOpenChange,
  onConfirm,
  danger = false,
}: Confirmation & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} autoFocus>
            取消
          </Button>
          <Button type="button" variant={danger ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
