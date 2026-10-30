/** In-app version of docs/glossary.md: the words the UI uses, and what they used to be called. */
export const glossary = [
  {
    term: '连接',
    meaning: '平台接入的一个 MCP 服务，保存地址或命令和凭证',
    was: 'MCP 连接、服务账号',
  },
  { term: '内置服务', meaning: '“添加连接”里预置的常用服务', was: '内置连接器' },
  {
    term: '运行位置',
    meaning: '平台服务器，或我的设备（通过设备连接器）；Pi 桥接是高级选项',
    was: '执行适配器、平台直连、平台主机',
  },
  { term: '连接方式', meaning: '远程地址（HTTP）或本地命令（stdio）', was: '传输协议、进程模式' },
  {
    term: '英文标识',
    meaning: '客户端里工具名的前缀：英文标识__工具名',
    was: '连接展示前缀',
  },
  { term: 'Agent', meaning: '一组权限，客户端以它的身份接入', was: 'Agent 配置、Profile' },
  {
    term: 'Agent 详情',
    meaning: '能用的工具、编辑权限、接入客户端；其余在“高级”',
    was: '工作空间',
  },
  { term: '客户端配置（不含密钥）', meaning: '只含地址和密钥占位符的配置', was: '配置模板' },
  { term: '批量配置', meaning: '用声明文件批量创建连接和 Agent（高级）', was: '配置模板' },
  {
    term: '工具列表',
    meaning: '连接提供的工具；“刷新工具列表”重新读取',
    was: '工具目录、更新目录',
  },
  {
    term: '提示词与资源',
    meaning: 'MCP 的 Prompts、Resources 和平台内容',
    was: 'Prompts 与 Resources、内容库',
  },
  { term: '文件', meaning: '上传、工具产出或交接的文件', was: '产物' },
  { term: '扩展包（.mcpb）', meaning: 'MCPB 格式的打包服务', was: 'MCPB 扩展包、Bundle' },
  { term: '测试身份：我自己', meaning: '在“工具”页用你自己的权限测试', was: '管理账号' },
  { term: '服务授权', meaning: '在 GitHub、Google 等服务方登录并授权', was: '上游授权' },
  { term: '用我的账号凭证', meaning: '共享连接时让对方用你的凭证调用', was: '所有者凭证' },
] as const;
