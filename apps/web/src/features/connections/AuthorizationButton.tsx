import { Action } from '../../components/shared/Controls.js';
import { api } from '../../lib/api.js';
import { authorizeConnection } from './authorizationFlow.js';

export function AuthorizationButton({
  endpoint,
  onResult,
}: {
  endpoint: string;
  onResult: (result: unknown) => void;
}) {
  return (
    <Action
      action={async () => {
        onResult(undefined);
        onResult(
          await authorizeConnection({
            endpoint,
            request: api,
            navigate: (url) => window.location.assign(url),
          }),
        );
      }}
    >
      发起授权
    </Action>
  );
}
