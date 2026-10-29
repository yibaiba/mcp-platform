import { z } from 'zod';
const argument = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    description: z.string().optional(),
    required: z.boolean().default(false),
  })
  .strict();
const common = {
  name: z.string().trim().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
};
export const libraryItem = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('prompt'),
        template: z.string(),
        arguments: z.array(argument).default([]),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('resource'),
        uri: z.url(),
        mimeType: z.string().min(1).default('text/plain'),
        content: z.string(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== 'prompt') return;
    const names = new Set(value.arguments.map((arg) => arg.name));
    if (names.size !== value.arguments.length)
      ctx.addIssue({ code: 'custom', message: '参数名不能重复' });
    for (const match of value.template.matchAll(/{{(.*?)}}/gs)) {
      if (!names.has(match[1]!))
        ctx.addIssue({ code: 'custom', message: `未声明的模板参数：${match[1]}` });
    }
    if (/{{|}}/.test(value.template.replace(/{{[^{}]*}}/g, '')))
      ctx.addIssue({ code: 'custom', message: '模板占位符必须使用完整的 {{parameter}}' });
  });
export type LibraryItem = z.infer<typeof libraryItem>;
export function renderPrompt(
  value: Extract<LibraryItem, { kind: 'prompt' }>,
  args: Record<string, string>,
) {
  const names = new Set(value.arguments.map((arg) => arg.name));
  for (const name of Object.keys(args)) if (!names.has(name)) throw new Error(`未知参数：${name}`);
  for (const arg of value.arguments)
    if (arg.required && !Object.hasOwn(args, arg.name))
      throw new Error(`缺少必填参数：${arg.name}`);
  return value.template.replace(/{{([^{}]*)}}/g, (_, name: string) =>
    Object.hasOwn(args, name) ? args[name]! : '',
  );
}
