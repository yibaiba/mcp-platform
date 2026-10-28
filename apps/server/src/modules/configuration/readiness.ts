import { DeploymentPending } from './values.js';
export function assertDeploymentReady(profile: { deploymentState: string }) {
  if (profile.deploymentState !== 'ready')
    throw new DeploymentPending('该 Profile 的声明尚未解析完成；请查看配置模板状态');
}
