import type { Parameter } from './types.js';
import { AppError } from '../../shared/errors.js';
const scalar = (value: unknown) => {
  if (value === null) return '';
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  throw new AppError('OPENAPI_SERIALIZATION', '参数包含不支持的嵌套值');
};
export function serializeParameter(parameter: Parameter, value: unknown): [string, string][] {
  const style = parameter.style ?? (['query', 'cookie'].includes(parameter.in) ? 'form' : 'simple');
  const explode = parameter.explode ?? style === 'form';
  const name = parameter.name;
  const atom = (item: unknown) =>
    parameter.in === 'path' ? encodeURIComponent(scalar(item)) : scalar(item);
  if (Array.isArray(value)) {
    const values = value.map(atom);
    if (style === 'form' && explode) return values.map((item) => [name, item]);
    if (style === 'matrix' && explode)
      return [[name, values.map((item) => `;${encodeURIComponent(name)}=${item}`).join('')]];
    const separator = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    return [
      [name, decorate(parameter, values.join(style === 'label' && explode ? '.' : separator))],
    ];
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, item]) =>
        [parameter.in === 'path' ? encodeURIComponent(key) : key, atom(item)] as const,
    );
    if (style === 'matrix' && explode)
      return [[name, entries.map(([key, item]) => `;${key}=${item}`).join('')]];
    if (style === 'deepObject') return entries.map(([key, item]) => [`${name}[${key}]`, item]);
    if (style === 'form' && explode) return entries.map(([key, item]) => [key, item]);
    const joined = entries
      .map(([key, item]) => (explode ? `${key}=${item}` : `${key},${item}`))
      .join(style === 'label' && explode ? '.' : ',');
    return [[name, decorate(parameter, joined)]];
  }
  return [[name, decorate(parameter, atom(value))]];
}
function decorate(parameter: Parameter, value: string) {
  if (parameter.style === 'label') return `.${value}`;
  if (parameter.style === 'matrix') return `;${encodeURIComponent(parameter.name)}=${value}`;
  return value;
}
