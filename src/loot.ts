import type { EnemyDefinition } from './config-types.js';
import type { EnemyInstance } from './combat.js';

// 敌人创建时生成一次背包；死亡、打开尸体与分解都不重新抽取战利品。
export function rollEnemyInventory(definition: EnemyDefinition, random: () => number = Math.random): Record<string, number> {
  const inventory: Record<string, number> = {};
  for (const entry of definition.loot ?? []) {
    if (entry.chance <= 0 || (entry.chance < 1 && random() >= entry.chance)) continue;
    const count = entry.min === entry.max ? entry.min : entry.min + Math.floor(random() * (entry.max - entry.min + 1));
    inventory[entry.itemId] = (inventory[entry.itemId] ?? 0) + count;
  }
  return inventory;
}
export interface CorpseSummary { id: string; name: string; location: string; templateId: string }
export interface CorpseView extends CorpseSummary { items: { itemId: string; name: string; quantity: number }[] }
export const isCorpse = (enemy: EnemyInstance) => enemy.health === 0 && !enemy.harvested;
export function corpseSummary(enemy: EnemyInstance): CorpseSummary {
  return { id: enemy.id, name: `${enemy.battleName}的尸体`, location: enemy.location, templateId: enemy.templateId };
}
