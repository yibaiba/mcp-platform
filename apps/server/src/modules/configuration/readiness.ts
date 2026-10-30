import { DeploymentPending } from './values.js';
export function assertDeploymentReady(profile: { deploymentState: string }) {
  if (profile.deploymentState !== 'ready')
    throw new DeploymentPending('该 Agent 的声明尚未解析完成；请查看批量配置状态');
}
