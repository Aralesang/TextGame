import type { CorpseView, CorpseSummary } from './loot.js';
import { worldEnemySummary } from './combat.js';
import { mapDefinitions } from './config.js';
import type { MapDefinition } from './config-types.js';
import { equipmentSummary, itemById, effectNames } from './rpg.js';
import type { EnemyView } from './combat.js';
import type { Player, GroundItem } from './game.js';

export interface Snapshot { selfId: string; players: Player[]; coinAvailable: boolean; dummies: EnemyView[]; items: GroundItem[]; corpses?: CorpseSummary[]; places: Record<string, MapDefinition> }
export type View = 'all' | 'status' | 'inventory' | 'map' | 'events' | 'commands';
export interface Display { state?: Snapshot; events: string[]; commands?: string[]; corpse?: CorpseView; connection: string; attach: string }

// 指令解析与渲染独立于终端设备，可在不打开浏览器的情况下测试。
export function parseCommand(line: string): Record<string, string | number> | 'quit' | 'help' | 'inventory' | 'closeInventory' {
  const [verb, ...words] = line.trim().split(/\s+/u);
  const text = words.join(' ');
  if (verb === '退出' || verb === 'quit') return 'quit';
  if (verb === '帮助' || verb === 'help' || verb === '?') return 'help';
  if (verb === '背包' || verb === 'inventory' || verb === 'bag') return 'inventory';
  if (verb === '关闭背包') return 'closeInventory';
  if (verb === '搜刮' || verb === 'loot') return { type: 'searchCorpse', target: text };
  if (verb === '分解' || verb === 'decompose') return { type: 'decomposeCorpse', target: text };
  if (verb === '关闭搜刮' || verb === 'close-loot') return { type: 'closeCorpse' };
  if (verb === '全部拿取' || verb === 'take-all') return { type: 'takeAllCorpseItems' };
  if (verb === '拿取' || verb === 'take') {
    const parts = [...words]; let quantity = '1';
    if (parts.length > 1 && /^(?:[0-9]+|全部|all)$/.test(parts[parts.length - 1])) quantity = parts.pop()!;
    return { type: 'takeCorpseItem', item: parts.join(' '), quantity: quantity === '全部' || quantity === 'all' ? 'all' : Number(quantity) };
  }
  if (verb === '装备' || verb === 'equip' || verb === '换武器' || verb === '换装') return text ? { type: 'equip', item: text } : { type: 'equipmentStatus' };
  if (verb === '卸下' || verb === 'unequip') return { type: 'unequip', item: text };
  if (verb === '使用' || verb === 'use') return { type: 'useItem', item: text };
  if (verb === '药水' || verb === 'potions' || verb === '道具' || verb === 'items') return { type: 'itemStatus' };
  if (verb === '技能' || verb === '施放' || verb === 'skill' || verb === 'cast') return words[0] ? { type: 'useSkill', skill: words[0], target: words.slice(1).join(' ') } : { type: 'skillStatus' };
  if (verb === '目标' || verb === 'target') return { type: 'selectTarget', target: text };
  if (/^[1-9][0-9]*$/.test(verb)) return { type: 'selectTarget', target: verb };
  if (verb === '防御' || verb === 'defend') return { type: 'defend' };
  if (verb === '攻击' || verb === 'attack') return text ? { type: 'attack', target: text } : { type: 'attack' };
  if (verb === '战斗' || verb === 'combat') return { type: 'combatStatus' };
  if (verb === '结束战斗') return { type: 'completeCombat' };
  if (verb === '脱离战斗' || verb === 'flee') return { type: 'leaveCombat' };
  if (verb === '查看' || verb === 'look') return { type: 'look' };
  if (verb === '拾取' || verb === 'pickup') {
    if (!text) throw new Error('请指定物品，例如「拾取 金币」。输入「查看」列出地面物品。');
    return { type: 'pickup', target: text };
  }
  if (verb === '说' || verb === 'say') {
    if (!text) throw new Error('请输入聊天内容，例如：说 你好');
    return { type: 'chat', text };
  }
  if (verb === '前往' || verb === 'go') {
    const target = Object.values(mapDefinitions).find(map => map.id === text || map.name === text)?.id;
    if (!target) throw new Error('可前往：' + Object.values(mapDefinitions).map(map => map.name).join('、'));
    return { type: 'move', target };
  }
  throw new Error('未知命令。输入「帮助」查看命令。');
}
export const help = '前往 地点名 | 背包 | 关闭背包 | 查看（环境与目标） | 拾取 物品名 | 搜刮 尸体名 | 拿取 物品名 [数量/全部] | 全部拿取 | 关闭搜刮 | 分解 尸体名 | 攻击 目标名 | 攻击 | 目标 序号 | 防御 | 战斗 | 脱离战斗 | 装备 [名称] | 技能 | 施放 技能名 [目标] | 道具 | 使用 物品名 | 说 内容 | 帮助 | 退出';
// 所有外部文字去除控制符，避免聊天或昵称注入终端转义序列。
export const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, '');
export function render(display: Display, view: View, rows = 30): string {
  const state = display.state;
  const self = state?.players.find(p => p.id === state.selfId);
  const sections: string[] = [`文字冒险 · ${display.connection}`];
  if (view === 'all' || view === 'status') sections.push('── 角色状态 ──', self && state ? `${self.name} · ${state.places[self.location].name} · 金币 ${self.coins}\n生命值 ${self.vitals.health}/100 · 法力值 ${self.vitals.mana}/100\n饱食度 ${self.vitals.satiety}/100 · 水分值 ${self.vitals.hydration}/100\n${equipmentSummary(self)}\n效果：${self.effects.map(e => `${effectNames[e.kind]} ${e.turns}次行动`).join("、") || "无"}\n战斗：${self.combat ? `${state.dummies.find(d => d.id === self.combat!.targetId)?.name} · 第${self.combat.round}回合` : '无'}\n在线 ${state.players.length} 人：${state.players.map(p => p.name).join('、')}` : '等待入场…');
  // 普通文字与独立视图同样把背包从角色状态中分离。
  if (view === 'inventory') sections.push('── 背包 ──', self ? Object.entries(self.inventory).filter(([, count]) => count > 0).map(([name, count]) => `${name} ×${count}${Object.values(self.equipment).some(id => itemById(id)?.name === name) ? " [已装备]" : ""}`).join('、') || '背包为空' : '等待入场…');
  if (view === 'all' || view === 'map') sections.push('── 地图 ──', state && self ? `当前位置：${state.places[self.location].name}；出口：${state.places[self.location].exits.map(id => state.places[id].name).join('、') || '无'}` : '等待地图状态…', state ? `当前位置地面物品：${state.items.filter(item => item.location === self?.location).map(item => `${item.name} ×${item.quantity}`).join('、') || '无'}\n地点敌人：${worldEnemySummary(state.dummies.filter(d => d.location === self?.location)).join('、') || '无'}\n尸体：${(state.corpses ?? []).filter(c => c.location === self?.location).map(c => `${c.name}（${c.id}）`).join('、') || '无'}\n${state.players.map(p => `${p.name}：${state.places[p.location].name}`).join(' / ')}` : '等待世界状态…');
  if (view === 'all' || view === 'events' || view === 'commands') {
    const limit = Math.max(2, rows - (view === 'all' ? 18 : 8));
    sections.push('── 事件与聊天 ──', ...display.events.slice(-limit));
  }
  if (display.corpse && (view === 'all' || view === 'commands')) sections.push(`── 搜刮：${display.corpse.name} ──`, display.corpse.items.map(item => `${item.name} ×${item.quantity}`).join('、') || '尸体背包为空', '拿取 物品名 [数量/全部] | 全部拿取 | 分解 | 关闭搜刮');
  if (view === 'all' || view === 'commands') sections.push('── 命令 ──', ...(display.commands ?? []).slice(-8), help);
  sections.push(`附加窗口：npm run view -- --attach ${display.attach} --view map`);
  return sections.map(section => section.split('\n').map(clean).join('\n')).join('\n');
}
