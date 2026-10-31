import { PageHeader } from '../../components/shared/PageHeader.js';
import { Card } from '../../components/ui/card.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Input } from '../../components/ui/input.js';
import { SelectItem } from '../../components/ui/select.js';
import { useState } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.js';

import { useQuery } from '@tanstack/react-query';
import { api, json, type Artifact, type Device } from '../../lib/api.js';
import {
  Code,
  date,
  Empty,
  Feedback,
  Field,
  Form,
  ListSkeleton,
  value,
} from '../../components/shared/Controls.js';
export default function ArtifactsPage() {
  const artifacts = useQuery({
    queryKey: ['artifacts'],
    queryFn: () => api<Artifact[]>('/artifacts'),
  });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const [result, setResult] = useState<unknown>();
  const [direction, setDirection] = useState('receive');
  const [drawer, setDrawer] = useState<'upload' | 'transfer'>();
  const open = (next: 'upload' | 'transfer') => {
    setResult(undefined);
    setDrawer(next);
  };
  return (
    <>
      <PageHeader
        title="Agent"
        info="使用文件 ID 传递文件，上传与接收均校验 SHA-256。"
        actions={
          <>
            <Button variant="outline" onClick={() => open('transfer')}>
              设备间交接
            </Button>
            <Button onClick={() => open('upload')}>
              <Upload aria-hidden="true" />
              上传文件
            </Button>
          </>
        }
      />
      <Feedback error={artifacts.error ?? devices.error} />
      <Card className="panel">
        {artifacts.isPending ? <ListSkeleton /> : null}
        {artifacts.data?.length ? (
          artifacts.data.map((artifact) => (
            <div className="row" key={artifact.id}>
              <div className="grow">
                <strong>{artifact.name}</strong>
                <small>
                  {artifact.size.toLocaleString()} bytes · {date(artifact.createdAt)}
                </small>
                <code className="break-all text-subtle-foreground">{artifact.id}</code>
              </div>
              <Button
                variant="ghost"
                size="sm"
                render={<a href={`/api/v1/artifacts/${artifact.id}/content`} />}
              >
                下载
              </Button>
            </div>
          ))
        ) : artifacts.isSuccess ? (
          <Empty
            icon={FolderOpen}
            title="还没有文件"
            action={
              <Button variant="outline" onClick={() => open('upload')}>
                上传文件
              </Button>
            }
          />
        ) : null}
      </Card>
      <Sheet
        open={Boolean(drawer)}
        onOpenChange={(next) => {
          if (!next) setDrawer(undefined);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{drawer === 'transfer' ? '设备间交接' : '上传文件'}</SheetTitle>
            <SheetDescription>
              {drawer === 'transfer'
                ? '本地目录名称需匹配 connector.json 中的 artifactRoots。'
                : '上传前在浏览器计算 SHA-256 并由平台校验。'}
            </SheetDescription>
          </SheetHeader>
          {drawer === 'upload' ? (
            <Form
              label="校验并上传"
              submit={async (data) => {
                const file = data.get('file');
                if (!(file instanceof File)) throw new Error('请选择文件');
                const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
                const sha256 = Array.from(new Uint8Array(hash), (b) =>
                  b.toString(16).padStart(2, '0'),
                ).join('');
                setResult(
                  await api('/artifacts', {
                    method: 'POST',
                    body: file,
                    headers: {
                      'X-File-Name': encodeURIComponent(file.name),
                      'X-Content-SHA256': sha256,
                    },
                  }),
                );
              }}
            >
              <Field label="文件">
                <Input type="file" name="file" required />
              </Field>
            </Form>
          ) : null}
          {drawer === 'transfer' ? (
            <Form
              label="开始传输"
              submit={async (data) =>
                setResult(
                  await api('/artifacts/transfers', {
                    method: 'POST',
                    body: json({
                      deviceId: value(data, 'deviceId'),
                      direction,
                      artifactId: direction === 'receive' ? value(data, 'artifactId') : undefined,
                      root: value(data, 'root'),
                      path: value(data, 'path'),
                    }),
                  }),
                )
              }
            >
              <Field label="传输方向">
                <SelectControl value={direction} onValueChange={setDirection}>
                  <SelectItem value="receive">设备接收平台文件</SelectItem>
                  <SelectItem value="send">设备上传本地文件</SelectItem>
                </SelectControl>
              </Field>
              <Field label="目标设备">
                <SelectControl name="deviceId" required>
                  <SelectItem value="">选择设备</SelectItem>
                  {devices.data
                    ?.filter((d) => !d.revoked)
                    .map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                </SelectControl>
              </Field>
              {direction === 'receive' ? (
                <Field label="文件">
                  <SelectControl name="artifactId" required>
                    <SelectItem value="">选择文件</SelectItem>
                    {artifacts.data?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} · {a.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectControl>
                </Field>
              ) : null}
              <Field label="本地目录名称" hint="必须匹配 connector.json 中的 artifactRoots">
                <Input name="root" defaultValue="workspace" required />
              </Field>
              <Field label="目录内相对路径">
                <Input name="path" placeholder="output/result.png" required />
              </Field>
            </Form>
          ) : null}
          {result ? <Code value={result} /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
