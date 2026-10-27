import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'Platform acceptance App', version: '1' }, {});
const status = document.querySelector('#status')!;
app.onteardown = async () => {
  console.info('Platform acceptance App teardown acknowledged');
  return {};
};
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.dataset.hostTheme = context.theme;
  if (context.displayMode) document.documentElement.dataset.displayMode = context.displayMode;
};
app.ontoolinput = (input) => {
  status.textContent = `参数已收到：${JSON.stringify(input.arguments)}`;
};
app.ontoolresult = (result) => {
  status.textContent = `结果已收到：${JSON.stringify(result.structuredContent)}`;
};
document.querySelector('#action')!.addEventListener('click', () => {
  void app.callServerTool({ name: 'app_action', arguments: {} }).then(
    (result) => {
      status.textContent = `App 工具调用成功：${JSON.stringify(result.structuredContent)}`;
    },
    (error) => {
      status.textContent = String(error);
    },
  );
});
void app.connect().then(
  () => {
    const context = app.getHostContext();
    if (context) app.onhostcontextchanged?.(context);
    document.documentElement.dataset.messageCapability = String(
      Boolean(app.getHostCapabilities()?.message),
    );
  },
  (error) => {
    status.textContent = String(error);
  },
);
