import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clientPresets, type ClientPreset } from '@platform/contracts';
import { api } from '../../lib/api.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Code, Feedback, Field } from '../../components/shared/Controls.js';
type Export = {
  preset: ClientPreset;
  config: string;
  command?: string;
  format: string;
  notes?: string;
};
export function ClientExport({ profileId, issued }: { profileId?: string; issued?: Export[] }) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<ClientPreset>('claude-code');
  const [copyError, setCopyError] = useState<Error>();
  const copy = async (text: string) => {
    setCopyError(undefined);
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      setCopyError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const query = useQuery({
    queryKey: ['client-export', profileId, preset],
    queryFn: () => api<Export>(`/profiles/${profileId}/export?client=${preset}`),
    enabled: open && !issued && Boolean(profileId),
  });
  const output = issued?.find((item) => item.preset === preset) ?? query.data;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {issued ? '复制完整客户端配置' : '导出客户端配置'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>客户端接入配置</DialogTitle>
          </DialogHeader>
          <p>
            {issued
              ? '此处包含刚生成的接入密钥，关闭密钥展示后不再提供。'
              : '凭证使用占位符；接入密钥仅在首次生成时显示。'}
          </p>
          <Field label="客户端">
            <SelectControl
              value={preset}
              onValueChange={(value) => setPreset(value as ClientPreset)}
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
              {output.notes ? (
                <p className="text-sm text-muted-foreground">{output.notes}</p>
              ) : null}
              <Code value={output.config} />
              <Button onClick={() => void copy(output.config)}>复制配置</Button>
              {output.command ? (
                <>
                  <Code value={output.command} />
                  <Button onClick={() => void copy(output.command!)}>复制 CLI 命令</Button>
                </>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
