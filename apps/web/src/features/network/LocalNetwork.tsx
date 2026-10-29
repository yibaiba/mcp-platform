import { useEffect, useState } from 'react';
import type { NetworkView } from '@platform/contracts';
import type { ManagementApi } from '../local/api.js';
import { NetworkEditor } from './NetworkEditor.js';
import { Feedback } from '../../components/shared/Controls.js';
export function LocalNetwork({ api }: { api: ManagementApi }) {
  const [view, setView] = useState<NetworkView>();
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void api.request({ action: 'network.get' }).then(
      (value) => {
        if (active) setView(value as NetworkView);
      },
      (error) => {
        if (active) setError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <section>
      <h2>设备网络与安装源</h2>
      <Feedback error={error} />
      {view ? (
        <NetworkEditor
          local
          initial={view}
          save={async (content) =>
            (await api.request({ action: 'network.save', content })) as NetworkView
          }
          check={async () =>
            (await api.request({ action: 'network.check' })) as {
              kind: string;
              url: string;
              ok: boolean;
              detail: string;
            }[]
          }
        />
      ) : null}
    </section>
  );
}
