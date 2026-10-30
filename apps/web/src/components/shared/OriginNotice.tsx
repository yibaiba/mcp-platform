/** Warns when the browser origin differs from PUBLIC_URL, which every copied address uses. */
export function OriginNotice({ platformOrigin }: { platformOrigin: string | undefined }) {
  if (!platformOrigin || platformOrigin === window.location.origin) return null;
  return (
    <p role="note" data-origin-mismatch className="text-sm text-amber-700 dark:text-amber-400">
      当前浏览器地址 <code>{window.location.origin}</code> 与平台对外地址（PUBLIC_URL）
      <code>{platformOrigin}</code> 不一致。下方命令和地址按 <code>{platformOrigin}</code>
      生成，设备与客户端须能访问该地址。本地开发（页面 4301 / 服务 4300）属正常情况；生产部署请把
      PUBLIC_URL 与 WEB_ORIGIN 设为同一真实地址。
    </p>
  );
}
