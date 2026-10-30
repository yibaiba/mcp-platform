import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clientPresets, type ClientPreset } from '@platform/contracts';
import { api } from '../../lib/api.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import {
  Code,
  Feedback,
  Field,
  InlineStatus,
  ListSkeleton,
} from '../../components/shared/Controls.js';
export type Export = {
  preset: ClientPreset;
  config: string;
  command?: string;
  format: string;
  notes?: string;
};
/** Client picker plus copy buttons; `issued` carries a freshly generated key. */
export function ClientExportBody({
  profileId,
  issued,
  enabled = true,
}: {
  profileId?: string;
  issued?: Export[];
  enabled?: boolean;
}) {
  const [preset, setPreset] = useState<ClientPreset>('claude-code');
  const [copyError, setCopyError] = useState<Error>();
  const [copied, setCopied] = useState<'config' | 'command'>();
  const copy = async (text: string, kind: 'config' | 'command') => {
    setCopyError(undefined);
    setCopied(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch (error) {
      setCopyError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const query = useQuery({
    queryKey: ['client-export', profileId, preset],
    queryFn: () => api<Export>(`/profiles/${profileId}/export?client=${preset}`),
    enabled: enabled && !issued && Boolean(profileId),
  });
  const output = issued?.find((item) => item.preset === preset) ?? query.data;
  return (
    <div className="grid gap-3">
      <Field label="客户端">
        <SelectControl
          value={preset}
          onValueChange={(value) => {
            setPreset(value as ClientPreset);
            setCopied(undefined);
            setCopyError(undefined);
          }}
        >
          {clientPresets.map((client) => (
            <SelectItem key={client} value={client}>
              {client}
            </SelectItem>
          ))}
        </SelectControl>
      </Field>
      <Feedback error={copyError ?? query.error} />
      {output ? (
        <>
          {output.notes ? <p className="text-sm text-muted-foreground">{output.notes}</p> : null}
          <Code value={output.config} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void copy(output.config, 'config')}>复制配置</Button>
            {output.command ? (
              <Button variant="outline" onClick={() => void copy(output.command!, 'command')}>
                复制 CLI 命令
              </Button>
            ) : null}
            {copied ? (
              <InlineStatus key={copied} onDone={() => setCopied(undefined)}>
                {copied === 'command' ? '已复制命令' : '已复制配置'}
              </InlineStatus>
            ) : null}
          </div>
          {output.command ? <Code value={output.command} /> : null}
        </>
      ) : query.isPending && !issued ? (
        <ListSkeleton rows={2} />
      ) : null}
    </div>
  );
}

export function ClientExport({ profileId, issued }: { profileId?: string; issued?: Export[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {issued ? '复制完整客户端配置' : '导出客户端配置'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>客户端接入配置</DialogTitle>
            <DialogDescription>
              {issued ? '包含刚生成的接入密钥。' : '凭证为占位符；密钥只在生成时显示。'}
            </DialogDescription>
          </DialogHeader>
          <ClientExportBody profileId={profileId} issued={issued} enabled={open} />
        </DialogContent>
      </Dialog>
    </>
  );
}
