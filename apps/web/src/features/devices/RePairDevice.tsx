import { useState } from 'react';
import { api, type Device } from '../../lib/api.js';
import { Action, Code, date } from '../../components/shared/Controls.js';
export function RePairDevice({
  device,
  platformOrigin,
}: {
  device: Device;
  platformOrigin: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>();
  return (
    <div className="padded">
      <button className="button" onClick={() => setConfirming(true)}>
        重新配对
      </button>
      {confirming ? (
        <div className="result" role="group" aria-label={`重新配对 ${device.name}`}>
          <p>
            生成重配码会立即断开此设备，旧密钥立即失效。设备
            ID、已有连接与目录配置将保留。未兑换或过期后仍需重新配对。
          </p>
          <Action
            danger
            action={async () => {
              setPairing(await api(`/devices/${device.id}/re-pairings`, { method: 'POST' }));
              setConfirming(false);
            }}
          >
            确认断线并生成重配码
          </Action>
          <button className="button" onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      ) : null}
      {pairing ? (
        <div className="result" role="status">
          <p>重配码仅在这里显示，请粘贴到连接器提示符。保存成功后重启连接器。</p>
          <Code value="connector re-pair --config connector.json" />
          <p>配置遗失时：</p>
          <Code
            value={`connector re-pair --config connector.json --server ${platformOrigin} --device-id ${device.id}`}
          />
          <Code value={pairing.code} />
          <small>有效期至 {date(pairing.expiresAt)}，仅可使用一次。再次生成会使此码失效。</small>
          <button className="button" onClick={() => setPairing(undefined)}>
            隐藏重配码
          </button>
        </div>
      ) : null}
    </div>
  );
}
