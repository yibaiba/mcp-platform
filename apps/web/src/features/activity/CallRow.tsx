import { TableCell, TableRow } from '../../components/ui/table.js';
import { Button } from '../../components/ui/button.js';
import { date, relativeTime, Status } from '../../components/shared/Controls.js';
import { Hint } from '../../components/ui/tooltip.js';
import type { Call } from '../../lib/api.js';
import { callDuration, callLocation, callPhase, type CallNames } from './callPresentation.js';
export function CallRow({
  call,
  names,
  onOpen,
}: {
  call: Call;
  names: CallNames;
  onOpen: () => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell>
        <Status value={call.status} />
      </TableCell>
      <TableCell className="max-w-sm whitespace-normal">
        <strong>{names.tools.get(call.toolId) ?? call.toolId}</strong>
        <div className="text-muted-foreground">
          {names.connections.get(call.connectionId) ?? call.connectionId} ·{' '}
          {callLocation(call, names)}
        </div>
        <div className="text-muted-foreground">
          {call.profileId ? (names.profiles.get(call.profileId) ?? call.profileId) : '管理账号'} ·{' '}
          {callPhase(call.phase)}
        </div>
      </TableCell>
      <TableCell>
        <Hint content={date(call.startedAt)}>
          <span>{relativeTime(call.startedAt)}</span>
        </Hint>
      </TableCell>
      <TableCell>{callDuration(call)}</TableCell>
      <TableCell className="max-w-sm whitespace-normal">
        {call.error ? (
          <p className="m-0 line-clamp-2 break-all text-destructive" title={call.error}>
            {call.error}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label="查看调用详情"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          详情
        </Button>
      </TableCell>
    </TableRow>
  );
}
