import { defaultSchema } from 'rehype-sanitize';

export const MESSAGE_MAX = 2000;

export function clampMessage(text: string): string {
  return text.length > MESSAGE_MAX ? text.slice(0, MESSAGE_MAX) : text;
}

// 在默认白名单基础上进一步收紧：不允许任何 raw HTML、style、事件属性。
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'].includes(t)),
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter((a) => a !== 'style' && !String(a).startsWith('on')),
  },
  strip: ['script', 'style'],
};