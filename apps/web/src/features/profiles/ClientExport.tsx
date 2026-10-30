import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  clientPresetInfo,
  clientPresets,
  featuredClientPresets,
  type ClientAuthMode,
  type ClientPreset,
} from '@platform/contracts';
import { ExternalLink } from 'lucide-react';
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
  auth?: ClientAuthMode;
  name?: string;
  config: string;
  command?: string;
  format: string;
  notes?: string;
  links?: { label: string; href: string }[];
};

const presetKey = 'mcp-platform:client-preset';
const otherPresets = clientPresets.filter(
  (preset) => !(featuredClientPresets as readonly string[]).includes(preset),
);
function storedPreset(): ClientPreset {
  try {
    const value = localStorage.getItem(presetKey);
    if (value && (clientPresets as readonly string[]).includes(value)) return value as ClientPreset;
  } catch {
    // Private mode: fall back to the default.
  }
  return 'cursor';
}
/** Remembers the last client so returning users land on their own client. */
export function useClientPreset() {
  const [preset, setPreset] = useState<ClientPreset>(storedPreset);
  return [
    preset,
    (value: ClientPreset) => {
      setPreset(value);
      try {
        localStorage.setItem(presetKey, value);
      } catch {
        // Keep the choice for this session only.
      }
    },
  ] as const;
}

/** Readable client cards for the common clients; everything else in one labelled select. */
export function ClientPicker({
  value,
  onChange,
}: {
  value: ClientPreset;
  onChange: (value: ClientPreset) => void;
}) {
  const other = !(featuredClientPresets as readonly string[]).includes(value);
  return (
    <div className="grid gap-2">
      <div className="client-cards" role="radiogroup" aria-label="选择你的客户端">
        {featuredClientPresets.map((preset) => (
          <button
            type="button"
            role="radio"
            aria-checked={value === preset}
            key={preset}
            className={`client-card${value === preset ? ' selected' : ''}`}
            onClick={() => onChange(preset)}
          >
            <strong>{clientPresetInfo[preset].label}</strong>
            <small>{clientPresetInfo[preset].description}</small>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={other}
          className={`client-card${other ? ' selected' : ''}`}
          onClick={() => {
            if (!other) onChange('generic-mcp-servers');
          }}
        >
          <strong>其他客户端</strong>
          <small>Windsurf、Cherry Studio、通用 JSON 等</small>
        </button>
      </div>
      {other ? (
        <Field label="客户端">
          <SelectControl value={value} onValueChange={(next) => onChange(next as ClientPreset)}>
            {otherPresets.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {clientPresetInfo[preset].label}
              </SelectItem>
            ))}
          </SelectControl>
        </Field>
      ) : null}
    </div>
  );
}

/** Config, one-click links and copy buttons for one client; `issued` carries a fresh key. */
export function ClientExportBody({
  profileId,
  issued,
  enabled = true,
  auth = 'key',
  preset: controlled,
}: {
  profileId?: string;
  issued?: Export[];
  enabled?: boolean;
  auth?: ClientAuthMode;
  /** When set, the caller owns the picker (shared between auth modes). */
  preset?: ClientPreset;
}) {
  const [own, setOwn] = useClientPreset();
  const preset = controlled ?? own;
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
    queryKey: ['client-export', profileId, preset, auth],
    queryFn: () => api<Export>(`/profiles/${profileId}/export?client=${preset}&auth=${auth}`),
    enabled: enabled && !issued && Boolean(profileId),
  });
  const output = issued?.find((item) => item.preset === preset) ?? query.data;
  return (
    <div className="grid gap-3">
      {controlled ? null : (
        <ClientPicker
          value={preset}
          onChange={(value) => {
            setOwn(value);
            setCopied(undefined);
            setCopyError(undefined);
          }}
        />
      )}
      <Feedback error={copyError ?? query.error} />
      {output ? (
        <>
          {output.notes ? <p className="text-sm text-muted-foreground">{output.notes}</p> : null}
          {output.links?.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {output.links.map((link, index) => (
                <Button
                  key={link.href}
                  variant={index === 0 ? 'default' : 'outline'}
                  render={<a href={link.href} />}
                >
                  <ExternalLink aria-hidden="true" />
                  {link.label}
                </Button>
              ))}
            </div>
          ) : null}
          <Code value={output.config} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={output.links?.length ? 'outline' : 'default'}
              onClick={() => void copy(output.config, 'config')}
            >
              复制配置
            </Button>
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
