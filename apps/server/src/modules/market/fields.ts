import type { MarketSelection, RegistryInputField } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
export type MarketField = RegistryInputField & { key: string };
export function inputFields(items: readonly RegistryInputField[], prefix: string): MarketField[] {
  return items.flatMap<MarketField>((field, index) => {
    const key = `${prefix}.${field.name ?? index}`;
    if (field.variables)
      return Object.entries(field.variables).map(([variable, definition]) => ({
        ...definition,
        isSecret: field.isSecret || definition.isSecret,
        isRepeated: field.isRepeated,
        key: `${key}.${variable}`,
        name: variable,
      }));
    return field.value === undefined ? [{ ...field, key }] : [];
  });
}
function selectedValue(
  field: RegistryInputField,
  input: { key: string; values: MarketSelection['values'] },
) {
  const value = input.values[input.key] ?? (field.isSecret ? undefined : field.default);
  if (value === undefined && field.isRequired)
    throw new AppError('MARKET_PARAMETER_REQUIRED', `请填写参数 ${input.key}`);
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (!field.isRepeated && values.length > 1)
    throw new AppError('MARKET_PARAMETER', `${input.key} 不支持重复值`);
  if (field.choices && values.some((value) => !field.choices!.includes(value)))
    throw new AppError('MARKET_PARAMETER', `${input.key} 必须使用声明的可选值`);
  return values;
}
export function fieldValues(
  field: RegistryInputField,
  input: { key: string; values: MarketSelection['values']; url?: boolean },
): string[] {
  if (field.value === undefined) return selectedValue(field, input);
  const variables = new Map(
    Object.entries(field.variables ?? {}).map(([name, definition]) => [
      name,
      selectedValue(
        {
          ...definition,
          isSecret: field.isSecret || definition.isSecret,
          isRequired: true,
          isRepeated: field.isRepeated,
        },
        { key: `${input.key}.${name}`, values: input.values },
      ),
    ]),
  );
  const count = Math.max(1, ...[...variables.values()].map((values) => values.length));
  if ([...variables.values()].some((values) => values.length !== 1 && values.length !== count))
    throw new AppError('MARKET_PARAMETER', '重复模板变量必须数量一致，或提供一个共用值');
  return Array.from({ length: count }, (_, index) =>
    field.value!.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      const values = variables.get(name);
      if (!values) throw new AppError('MARKET_PARAMETER', `未声明模板变量 ${name}`);
      const value = values.length === 1 ? values[0]! : values[index]!;
      return input.url ? encodeURIComponent(value) : value;
    }),
  );
}
export function argumentsFor(
  items: readonly RegistryInputField[],
  input: { prefix: string; values: MarketSelection['values'] },
) {
  return items.flatMap((field, index) => {
    const key = `${input.prefix}.${field.name ?? index}`;
    const values = fieldValues(field, { key, values: input.values });
    if (field.type === 'named') {
      if (!field.name || !/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(field.name))
        throw new AppError('MARKET_PARAMETER', '命名参数缺少有效选项名');
      if (field.format === 'boolean')
        return values.flatMap((value) => {
          if (!['true', 'false'].includes(value))
            throw new AppError('MARKET_PARAMETER', `${key} 必须为 true 或 false`);
          return value === 'true' ? [field.name!] : [];
        });
      return values.flatMap((value) => [field.name!, value]);
    }
    if (field.type !== 'positional')
      throw new AppError('MARKET_PARAMETER', '命令参数缺少 positional/named 类型');
    return values;
  });
}
export function namedValues(
  items: readonly RegistryInputField[],
  input: { prefix: string; values: MarketSelection['values'] },
) {
  return Object.fromEntries(
    items.flatMap((field) => {
      if (!field.name) throw new AppError('MARKET_PARAMETER', '环境变量或请求头缺少名称');
      if (
        input.prefix === 'env'
          ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)
          : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(field.name)
      )
        throw new AppError('MARKET_PARAMETER', '环境变量或请求头名称不合法');
      const values = fieldValues(field, {
        key: `${input.prefix}.${field.name}`,
        values: input.values,
      });
      if (values.length > 1) throw new AppError('MARKET_PARAMETER', '环境变量和请求头不能重复');
      return values.length ? [[field.name, values[0]!]] : [];
    }),
  );
}
