import type { CorpseView } from './loot.js';

// 尸体与宝箱一样提供取出操作；空背包优先选关闭，避免连续按空格误分解。
export function corpseChoices(view: CorpseView) {
  return [
    ...view.items.map(item => ({ label: `${item.name} ×${item.quantity}`, command: `拿取 ${item.itemId}` })),
    ...(view.items.length ? [{ label: '全部拿取', command: '全部拿取' }] : []),
    { label: '关闭搜刮', command: '关闭搜刮' },
    { label: '分解尸体', command: `分解 ${view.id}` },
  ];
}
