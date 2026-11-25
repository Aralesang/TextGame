import { rollEnemyInventory } from './loot.js';
import { gameConfig } from './config.js';
import type { EnemyDefinition, EnemyAction } from './config-types.js';

// 生命无限使用字符串表示；正常敌人保留当前值与上限，所有状态仅由服务器维护。
export interface EnemyInstance extends EnemyDefinition {
  templateId: string; battleName: string; location: string; group: string;
  maxHealth: number | 'infinite'; maxMana: number; hits: number; damageTaken: number;
  inventory: Record<string, number>; harvested: boolean;
  actionsTaken: number; defending: boolean; engagedBy: string | null;
}
// 保留已有协议名称，旧的木桩接口现在也可承载普通敌人。
export type TrainingDummy = EnemyInstance;
export interface CombatState { targetId: string; enemyIds: string[]; round: number; turn: 'player' | 'target' | 'finished'; damageDealt: number; outcome?: 'victory' | 'defeat' }
export function createDummies(random: () => number = Math.random): EnemyInstance[] {
  return gameConfig.world.maps.flatMap(map => (map.encounters ?? []).flatMap(encounter => {
    const definitions = encounter.members.flatMap(member => Array.from({ length: member.count }, () => gameConfig.enemies.find(enemy => enemy.id === member.enemyId)!));
    const seen = new Map<string, number>();
    return definitions.map((definition, i) => {
      const number = seen.get(definition.name) ?? 0; seen.set(definition.name, number + 1);
      // 基础定义只有一个名字；战斗中同名实例自动加 A/B/C，数量变化无需复制配置。
      const battleName = definitions.filter(enemy => enemy.name === definition.name).length > 1 ? `${definition.name} ${String.fromCharCode(65 + number)}` : definition.name;
      return { ...structuredClone(definition), id: `${encounter.id}-${i + 1}`, templateId: definition.id, battleName, location: map.id, group: encounter.id,
        inventory: rollEnemyInventory(definition, random), harvested: false, maxHealth: definition.health, maxMana: definition.mana, hits: 0, damageTaken: 0, actionsTaken: 0, defending: false, engagedBy: null };
    });
  }));
}
export type EnemyView = Omit<EnemyInstance, 'inventory'>;
export const enemyLabel = (enemy: EnemyView) => enemy.battleName;
// 地图只显示种类和数量，战斗内才使用临时后缀标识。
export function worldEnemySummary(enemies: EnemyView[]) {
  const groups = new Map<string, EnemyView[]>();
  enemies.forEach(enemy => { const key = `${enemy.group}:${enemy.templateId}`; groups.set(key, [...(groups.get(key) ?? []), enemy]); });
  return [...groups.values()].map(group => group.length > 1 ? `${group[0].name} ×${group.length}${group.every(isAlive) ? '' : `（存活${group.filter(isAlive).length}）`}` : `${group[0].name} HP ${healthText(group[0])}${isAlive(group[0]) ? '' : ' [已倒下]'}`);
}
export const isAlive = (enemy: EnemyView) => enemy.health === 'infinite' || enemy.health > 0;
export const healthText = (enemy: EnemyView) => enemy.health === 'infinite' ? '∞' : `${enemy.health}/${enemy.maxHealth}`;
export function mitigatedDamage(power: number, defense: number, guarding: boolean, magic = false) {
  const afterDefense = Math.max(1, Math.floor(power - defense * (magic ? 0.5 : 1)));
  return guarding ? Math.max(1, Math.floor(afterDefense / 2)) : afterDefense;
}
// 规则先判断触发条件与法力；条件不满足时采用配置的后备行动。
export function chooseEnemyAction(enemy: EnemyInstance): EnemyAction {
  const ai = enemy.behavior;
  const available = (action: EnemyAction) => {
    const when = action.when;
    if (when?.every && (enemy.actionsTaken + 1) % when.every !== 0) return false;
    if (when?.healthBelowPercent !== undefined && (enemy.health === 'infinite' || enemy.health / Number(enemy.maxHealth) * 100 > when.healthBelowPercent)) return false;
    if (action.type === 'skill') {
      const skill = gameConfig.skills.find(skill => skill.id === action.skill)!;
      if (enemy.mana < skill.cost) return false;
      if (skill.target === 'self' && (enemy.health === 'infinite' || enemy.health >= Number(enemy.maxHealth))) return false;
    }
    return true;
  };
  if (ai.mode === 'idle' || ai.mode === 'attack') return { type: ai.mode };
  const action = ai.mode === 'cycle' ? ai.actions[enemy.actionsTaken % ai.actions.length] : ai.actions.find(available);
  return action && available(action) ? action : { type: ai.fallback };
}
