import { readFile } from 'node:fs/promises';
import { fixtureApp } from './fixtureApp.js';
const script = await readFile('.data/app-fixture/app.js', 'utf8');
const fixture = await fixtureApp(
  `<!doctype html><meta charset="utf-8"><h1>隔离 App 验收</h1><p id="status">连接宿主…</p><button id="action">调用 App 专用工具</button><script>${script.replaceAll('</script', '<\\/script')}</script>`,
  { port: 54820 },
);
console.log(`Browser App fixture: ${fixture.url}`);
process.once('SIGTERM', () => {
  void fixture.close();
});
process.once('SIGINT', () => {
  void fixture.close();
});
