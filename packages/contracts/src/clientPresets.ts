export const clientPresets = [
  'generic-mcp-servers',
  'claude-code',
  'cursor',
  'vscode',
  'codex',
  'opencode',
  'windsurf',
  'cherry-studio',
  'codebuddy',
  'qoder',
  'trae',
  'zcode',
  'workbuddy',
  'generic-http',
] as const;
export type ClientPreset = (typeof clientPresets)[number];
