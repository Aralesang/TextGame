import { isCorpse, corpseSummary, type CorpseView } from './loot.js';
import { gameConfig, mapDefinitions } from './config.js';
import { createDummies, isAlive, healthText, enemyLabel, worldEnemySummary, mitigatedDamage, chooseEnemyAction, type EnemyInstance, type CombatState } from './combat.js';
import { initialRpgState, starterInventory, stats, equip, unequip, drink, skillDefinitions, effectNames, type EquipmentSlot, type StatusEffect, type EffectKind } from './rpg.js';
import { randomUUID } from 'node:crypto';

// 世界只存在于服务器内存；重启服务器会重置金币和玩家。
export type Location = string;
// 生存属性由服务器初始化并同步；当前版本不自动消耗或恢复。
export interface Vitals { health: number; mana: number; satiety: number; hydration: number }
export const initialVitals: Vitals = gameConfig.player.vitals;
export interface Player { equipment: Record<EquipmentSlot, string | null>; skills: string[]; effects: StatusEffect[]; id: string; name: string; location: Location; coins: number; combat: CombatState | null; vitals: Vitals; inventory: Record<string, number> }
export const places = mapDefinitions;
// 地面物品使用唯一 ID；拾取目标可以使用 ID 或显示名称。
export interface GroundItem { id: string; itemId: string; name: string; location: Location; quantity: number; currencyValue?: number }
export class Game {
  players = new Map<string, Player>();
  enemies: EnemyInstance[];
  private openedCorpses = new Map<string, string>();
  constructor(random: () => number = Math.random) { this.enemies = createDummies(random); }
  // 兼容早期木桩命名，运行时已统一为通用敌人列表。
  get dummies() { return this.enemies; }
  // 地面物品按地图配置独立生成，名称和货币行为取自物品定义。
  items: GroundItem[] = gameConfig.world.maps.flatMap(map => map.groundItems.map(spawn => {
    const item = gameConfig.items.find(item => item.id === spawn.itemId)!;
    return { ...spawn, name: item.name, location: map.id, currencyValue: item.currencyValue };
  }));
  get coinAvailable() { return this.items.some(item => (item.currencyValue ?? 0) > 0 && item.quantity > 0); }
  join(name: unknown): Player {
    if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 16 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('昵称须为 1～16 个可见字符。');
    name = name.trim();
    if ([...this.players.values()].some(p => p.name === name)) throw new Error('这个昵称已被使用。');
    const player: Player = { id: randomUUID(), name: name as string, location: gameConfig.world.startMap, ...initialRpgState(), coins: gameConfig.player.coins, combat: null, vitals: { ...initialVitals }, inventory: starterInventory() };
    this.players.set(player.id, player);
    return player;
  }
  move(player: Player, target: unknown) {
    if (typeof target !== 'string') throw new Error('这个地点不存在。');
    const destination = gameConfig.world.maps.find(map => map.id === target || map.name === target);
    if (!destination) throw new Error('这个地点不存在。');
    target = destination.id;
    if (target === player.location) throw new Error('你已经在这里了。');
    if (!places[player.location].exits.includes(destination.id)) throw new Error('这里没有通往该地点的道路，输入「查看」确认出口。');
    if (player.combat?.outcome) throw new Error('战斗已结束，请先完成结算。');
    this.releaseEncounter(player.id); this.openedCorpses.delete(player.id);
    // 离开地点自动退出练习，不把战斗目标带到其他地图。
    player.combat = null; player.effects = [];
    player.location = destination.id;
  }
  // 查看仅返回玩家当前地点的物品，不改变世界状态。
  look(player: Player) {
    const place = places[player.location];
    const items = this.items.filter(item => item.location === player.location && item.quantity > 0);
    const targets = this.enemies.filter(dummy => dummy.location === player.location && isAlive(dummy));
    const training = targets.length ? ` 地点敌人：${worldEnemySummary(targets).join('、')}。输入「攻击 ${targets[0].name}」进入战斗，「脱离战斗」停止。` : '';
    const corpses = this.enemies.filter(enemy => enemy.location === player.location && isCorpse(enemy));
    const remains = corpses.length ? ` 尸体：${corpses.map(enemy => `${corpseSummary(enemy).name}（${enemy.id}）`).join('、')}。可用「搜刮 尸体名」打开背包，或「分解 尸体名」将资源散落地面。` : '';
    return `${place.name}：${place.description} 地面物品：${items.length ? items.map(item => `${item.name}（${item.id}）×${item.quantity}`).join('、') : '无'}。${items.length ? '输入「拾取 物品名」选择拾取，例如「拾取 ' + items[0].name + '」。' : '可用「前往 地点名」移动。'}${training}${remains} 出口：${place.exits.map(id => places[id].name).join("、") || "无"}。`;
  }
  // 校验与扣减同步执行，多个玩家不能重复获得同一件地面物品。
  pickup(player: Player, target: unknown) {
    if (player.combat?.outcome) throw new Error('战斗已结束，请先完成结算。');
    if (typeof target !== 'string' || !target.trim()) throw new Error('请指定物品，例如「拾取 金币」。输入「查看」列出地面物品。');
    const matching = this.items.filter(item => item.location === player.location && (item.id === target.trim() || item.name === target.trim()));
    const item = matching.find(item => item.quantity > 0) ?? matching[0];
    if (!item) throw new Error('这里没有该物品。输入「查看」列出地面物品。');
    if (item.quantity <= 0) throw new Error(`${item.name}已经被拾取。输入「查看」确认剩余物品。`);
    item.quantity -= 1;
    this.giveItem(player, item.itemId, 1);
    return item;
  }
  // 木桩仇恨联动：攻击任意一个先建立一对二遭遇，等待玩家选择行动。
  attack(player: Player, target: unknown) {
    this.requirePlayerTurn(player);
    if (target !== undefined && typeof target !== 'string') throw new Error('攻击目标无效。');
    const requested = typeof target === 'string' ? target.trim() : '';
    const targetId = requested || player.combat?.targetId;
    if (!targetId) throw new Error('请指定目标，例如「攻击 目标名」。输入「查看」列出当前地点的目标。');
    const dummy = this.findCombatTarget(player, targetId);
    if (!player.combat) {
      const group = this.enemies.filter(d => d.location === player.location && d.group === dummy.group && isAlive(d));
      if (group.some(enemy => enemy.engagedBy && enemy.engagedBy !== player.id)) throw new Error('这些敌人正在与其他玩家战斗。');
      // 仅无限生命且待机的练习组允许共享，其余遭遇独占，杜绝跨回合重复击杀。
      if (!group.every(enemy => enemy.health === 'infinite' && enemy.behavior.mode === 'idle')) group.forEach(enemy => { enemy.engagedBy = player.id; });
      this.openedCorpses.delete(player.id);
      player.combat = { targetId: dummy.id, enemyIds: group.map(d => d.id), round: 1, turn: 'player', damageDealt: 0 };
      return { dummy, round: 1, damage: 0, started: true, lines: [group.length > 1 ? `战斗开始！${player.combat.enemyIds.map(id => enemyLabel(this.enemies.find(d => d.id === id)!)).join('、')}仇恨联动，一同参战。` : `战斗开始！遭遇${enemyLabel(dummy)}。`, `第1回合，由你先行动。当前目标：${enemyLabel(dummy)}。`] };
    }
    const combat = player.combat;
    if (combat.turn !== 'player') throw new Error('现在不是你的回合。');
    combat.targetId = dummy.id;
    const round = combat.round, damage = this.hurtEnemy(player, dummy, stats(player).attack);
    // 伤害由服务器固定计算，选择目标本身不消耗回合。
    return { dummy, round, damage, started: false, lines: [
      `第${round}回合，你攻击${enemyLabel(dummy)}，造成 ${damage} 点伤害。${enemyLabel(dummy)}生命：${healthText(dummy)}。`,
      ...(isAlive(dummy) ? [] : [`${enemyLabel(dummy)}倒下了！`]),
      ...this.finishPlayerTurn(player),
    ] };
  }
  private findCombatTarget(player: Player, target: unknown) {
    if (typeof target !== 'string' || !target.trim()) throw new Error('请指定目标，例如「目标 1」或「目标 敌人名称」。');
    const value = target.trim();
    const id = player.combat && /^[1-9][0-9]*$/.test(value) ? player.combat.enemyIds[Number(value) - 1] : value;
    const candidates = this.enemies.filter(d => !d.harvested && d.location === player.location && (!player.combat || player.combat.enemyIds.includes(d.id))
      && (d.id === id || d.templateId === id || d.name === id || d.battleName === id));
    const dummy = candidates.find(enemy => isAlive(enemy) && (!enemy.engagedBy || enemy.engagedBy === player.id)) ?? candidates.find(isAlive) ?? candidates[0];
    if (!dummy) throw new Error('当前地点没有这个攻击目标。输入「查看」确认。');
    if (!isAlive(dummy)) throw new Error('这个目标已经倒下。');
    if (dummy.engagedBy && dummy.engagedBy !== player.id) throw new Error('该敌人正在与其他玩家战斗。');
    return dummy;
  }
  selectCombatTarget(player: Player, target: unknown) {
    if (!player.combat) throw new Error('当前未在战斗中。先用「攻击 目标名」进入战斗。');
    this.requirePlayerTurn(player);
    const dummy = this.findCombatTarget(player, target);
    player.combat.targetId = dummy.id;
    return `当前目标切换为${enemyLabel(dummy)}。选择目标不消耗回合。`;
  }
  defend(player: Player) {
    if (!player.combat) throw new Error('当前未在战斗中。');
    this.requirePlayerTurn(player);
    return [`第${player.combat.round}回合，你采取防御姿态。`, ...this.finishPlayerTurn(player, undefined, true)];
  }
  private requirePlayerTurn(player: Player) {
    if (player.combat?.outcome) throw new Error('战斗已结束，请先完成结算。');
    if (player.combat && player.combat.turn !== 'player') throw new Error('现在不是你的回合。');
    if (player.vitals.health <= 0) throw new Error('生命值不足，无法行动。');
  }
  changeEquipment(player: Player, value: unknown, remove = false) {
    this.requirePlayerTurn(player);
    const line = remove ? unequip(player, value) : equip(player, value);
    return [line, ...(player.combat ? this.finishPlayerTurn(player) : [])];
  }
  useItem(player: Player, value: unknown) {
    this.requirePlayerTurn(player);
    const result = drink(player, value);
    return [result.line, ...(player.combat ? this.finishPlayerTurn(player, result.skipEffect) : [])];
  }
  useSkill(player: Player, value: unknown, target: unknown) {
    this.requirePlayerTurn(player);
    const skill = skillDefinitions.find(s => s.id === value || s.name === value);
    if (!skill || !player.skills.includes(skill.id)) throw new Error('尚未掌握该技能。');
    if (player.vitals.mana < skill.cost) throw new Error('法力不足。');
    if (skill.target !== 'self' && !player.combat) throw new Error('攻击技能只能在战斗中施放。');
    if (skill.heal && player.vitals.health >= 100) throw new Error('生命已满，不需要治疗。');
    // 先完成目标、法力和效果校验，再扣资源，失败不能消耗回合或法力。
    const targets = skill.target === 'self' ? [] : skill.target === 'all' ? player.combat!.enemyIds.map(id => this.enemies.find(e => e.id === id)!).filter(isAlive) : [this.findCombatTarget(player, target || player.combat!.targetId)];
    const power = stats(player);
    player.vitals.mana -= skill.cost;
    const lines = [`你施放${skill.name}，消耗 ${skill.cost} 点法力。`];
    if (skill.heal) { const gain = Math.min(skill.heal, 100 - player.vitals.health); player.vitals.health += gain; lines.push(`恢复生命 ${gain}。`); }
    for (const dummy of targets) {
      const damage = this.hurtEnemy(player, dummy, skill.multiplier ? Math.max(1, Math.floor(power.attack * skill.multiplier)) : skill.damage! + power.magic, skill.multiplier === undefined);
      lines.push(`${skill.name}命中${enemyLabel(dummy)}，造成 ${damage} 点伤害。生命 ${healthText(dummy)}。`);
      if (!isAlive(dummy)) lines.push(`${enemyLabel(dummy)}倒下了！`);
    }
    if (skill.target === 'enemy') player.combat!.targetId = targets[0].id;
    return [...lines, ...(player.combat ? this.finishPlayerTurn(player) : [])];
  }
  private hurtEnemy(player: Player, enemy: EnemyInstance, power: number, magic = false) {
    const value = mitigatedDamage(power, enemy.defense, enemy.defending, magic);
    const damage = enemy.health === 'infinite' ? value : Math.min(value, enemy.health);
    if (enemy.health !== 'infinite') enemy.health -= damage;
    enemy.hits += 1; enemy.damageTaken += damage; player.combat!.damageDealt += damage;
    return damage;
  }
  private finishPlayerTurn(player: Player, skipEffect?: EffectKind, guarding = false) {
    const combat = player.combat!;
    const living = () => combat.enemyIds.map(id => this.enemies.find(enemy => enemy.id === id)!).filter(isAlive);
    // 最后一个敌人倒下即胜利，不再执行任何敌方行动。
    if (!living().length) { combat.outcome = 'victory'; combat.turn = 'finished'; return ['所有敌人都倒下了。战斗胜利！']; }
    if (!living().some(enemy => enemy.id === combat.targetId)) combat.targetId = living()[0].id;
    combat.turn = 'target';
    const lines: string[] = [];
    for (const effect of player.effects) {
      if (effect.kind === skipEffect) continue;
      if (effect.kind === 'regeneration') {
        const gain = Math.min(effect.power, 100 - player.vitals.health); player.vitals.health += gain;
        lines.push(`生命再生恢复 ${gain} 点生命。`);
      }
      effect.turns -= 1;
      if (effect.turns <= 0) lines.push(`${effectNames[effect.kind]}效果结束。`);
    }
    player.effects = player.effects.filter(effect => effect.turns > 0);
    for (const enemy of living()) {
      enemy.defending = false;
      const action = chooseEnemyAction(enemy); enemy.actionsTaken += 1;
      const prefix = `${enemyLabel(enemy)}的回合：`;
      if (action.type === 'idle') { lines.push(prefix + enemyLabel(enemy) + enemy.idleText); continue; }
      if (action.type === 'defend') { enemy.defending = true; lines.push(prefix + `${enemyLabel(enemy)}摆出防御姿态。`); continue; }
      let attack = enemy.attack, magic = false, name = '普通攻击';
      if (action.type === 'skill') {
        const skill = skillDefinitions.find(skill => skill.id === action.skill)!;
        enemy.mana -= skill.cost;
        if (skill.target === 'self') {
          const gain = Math.min(skill.heal!, Number(enemy.maxHealth) - Number(enemy.health));
          enemy.health = Number(enemy.health) + gain;
          lines.push(prefix + `${enemyLabel(enemy)}施放${skill.name}，消耗 ${skill.cost} 点法力，恢复 ${gain} 点生命。`); continue;
        }
        attack = skill.multiplier ? Math.floor(enemy.attack * skill.multiplier) : skill.damage! + enemy.magic;
        magic = skill.multiplier === undefined; name = `${skill.name}（消耗${skill.cost}法力）`;
      }
      const damage = Math.min(player.vitals.health, mitigatedDamage(attack, stats(player).defense, guarding, magic));
      player.vitals.health -= damage;
      lines.push(prefix + `${enemyLabel(enemy)}使用${name}，对你造成 ${damage} 点伤害${guarding ? '（已防御减伤）' : ''}。你的生命 ${player.vitals.health}/100。`);
      if (player.vitals.health <= 0) {
        combat.outcome = 'defeat'; combat.turn = 'finished';
        return [...lines, '你倒下了。战斗失败，将返回出生地点恢复状态。'];
      }
    }
    combat.turn = 'player'; combat.round += 1;
    return [...lines, `第${combat.round}回合，轮到你行动。`];
  }
  private releaseEncounter(playerId: string) {
    for (const enemy of this.enemies) if (enemy.engagedBy === playerId) { enemy.engagedBy = null; enemy.defending = false; }
  }
  // 播报完胜负后自动结束；敌人死亡状态保留，测试版玩家失败后无惩罚复活。
  completeCombat(player: Player) {
    const outcome = player.combat?.outcome;
    if (!outcome) throw new Error('战斗尚未结束。');
    this.releaseEncounter(player.id); player.combat = null; player.effects = [];
    if (outcome === 'defeat') { player.location = gameConfig.world.startMap; player.vitals = { ...initialVitals }; }
    return outcome === 'victory' ? '战斗胜利，返回探索。' : `你已在${places[player.location].name}恢复初始状态。`;
  }
  removePlayer(id: string) { this.openedCorpses.delete(id); this.releaseEncounter(id); this.players.delete(id); }
  combatStatus(player: Player) {
    const combat = player.combat;
    if (!combat) return `当前未在战斗中。使用「攻击 目标名」进入战斗。当前地点目标：${this.enemies.filter(d => d.location === player.location && isAlive(d) && !d.harvested).map(d => d.name).join('、') || '无'}。`;
    const dummy = this.enemies.find(d => d.id === combat.targetId)!;
    if (combat.outcome) return `战斗${combat.outcome === 'victory' ? '胜利' : '失败'}，正在结算。`;
    return `敌人：${combat.enemyIds.map(id => enemyLabel(this.enemies.find(d => d.id === id)!)).join('、')}（${combat.enemyIds.map(id => healthText(this.enemies.find(d => d.id === id)!)).join("、")}）。当前目标：${enemyLabel(dummy)}。第${combat.round}回合，轮到你行动。本次累计伤害 ${combat.damageDealt}。`;
  }
  leaveCombat(player: Player) {
    if (!player.combat) throw new Error('当前没有正在进行的战斗。');
    if (player.combat.outcome) throw new Error('战斗已结束，请先完成结算。');
    this.releaseEncounter(player.id);
    const dummy = this.enemies.find(d => d.id === player.combat!.targetId)!;
    player.combat = null; player.effects = [];
    return dummy;
  }
  private giveItem(player: Player, itemId: string, quantity: number) {
    const item = gameConfig.items.find(item => item.id === itemId)!;
    player.inventory[item.name] = (player.inventory[item.name] ?? 0) + quantity;
    player.coins += (item.currencyValue ?? 0) * quantity;
  }
  private requireCorpseAccess(player: Player) {
    if (player.combat) throw new Error('请先结束战斗，再处理尸体。');
    if (player.vitals.health <= 0) throw new Error('当前无法处理尸体。');
  }
  private findCorpse(player: Player, target: unknown) {
    this.requireCorpseAccess(player);
    const corpses = this.enemies.filter(enemy => enemy.location === player.location && isCorpse(enemy));
    const value = typeof target === 'string' ? target.trim() : '';
    if (target !== undefined && typeof target !== 'string') throw new Error('尸体目标无效。');
    const exact = corpses.find(enemy => enemy.id === value);
    const candidates = exact ? [exact] : corpses.filter(enemy => !value || enemy.name === value || enemy.battleName === value || corpseSummary(enemy).name === value || enemy.templateId === value);
    if (!candidates.length) throw new Error('这里没有该尸体，或尸体已经被分解。');
    if (candidates.length > 1) throw new Error('有多个尸体，请指定：' + candidates.map(enemy => `${corpseSummary(enemy).name}（${enemy.id}）`).join('、'));
    const corpse = candidates[0];
    if (corpse.engagedBy) throw new Error('这场战斗尚未结算，暂时不能处理尸体。');
    return corpse;
  }
  searchCorpse(player: Player, target: unknown) {
    const corpse = this.findCorpse(player, target);
    this.openedCorpses.set(player.id, corpse.id);
    return this.getOpenCorpse(player)!;
  }
  getOpenCorpse(player: Player): CorpseView | null {
    const corpse = this.enemies.find(enemy => enemy.id === this.openedCorpses.get(player.id));
    if (!corpse || !isCorpse(corpse) || corpse.location !== player.location || player.combat || corpse.engagedBy) { this.openedCorpses.delete(player.id); return null; }
    return { ...corpseSummary(corpse), items: Object.entries(corpse.inventory).filter(([, quantity]) => quantity > 0).map(([itemId, quantity]) => ({ itemId, quantity, name: gameConfig.items.find(item => item.id === itemId)!.name })) };
  }
  closeCorpse(player: Player) { this.openedCorpses.delete(player.id); }
  takeFromCorpse(player: Player, itemName: unknown, quantity: unknown = 1) {
    this.requireCorpseAccess(player);
    const view = this.getOpenCorpse(player);
    if (!view) throw new Error('请先「搜刮 尸体名」打开尸体背包。');
    if (typeof itemName !== 'string') throw new Error('请指定要拿取的物品。');
    const item = view.items.find(item => item.itemId === itemName || item.name === itemName);
    if (!item) throw new Error('尸体中没有该物品，可能已被其他玩家拿走。');
    const count = quantity === 'all' ? item.quantity : quantity;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > item.quantity) throw new Error('拿取数量无效或尸体中的数量不足。');
    const corpse = this.enemies.find(enemy => enemy.id === view.id)!;
    // 校验、扣除与入包无异步间隙；所有玩家观察同一个尸体背包。
    corpse.inventory[item.itemId] -= count; this.giveItem(player, item.itemId, count);
    return `${item.name} ×${count}`;
  }
  takeAllFromCorpse(player: Player) {
    this.requireCorpseAccess(player);
    const view = this.getOpenCorpse(player);
    if (!view) throw new Error('请先「搜刮 尸体名」打开尸体背包。');
    if (!view.items.length) throw new Error('尸体背包已经空了。');
    const corpse = this.enemies.find(enemy => enemy.id === view.id)!;
    view.items.forEach(item => { corpse.inventory[item.itemId] = 0; this.giveItem(player, item.itemId, item.quantity); });
    return view.items.map(item => `${item.name} ×${item.quantity}`).join('、');
  }
  decomposeCorpse(player: Player, target?: unknown) {
    const corpse = this.findCorpse(player, target === undefined || target === '' ? this.openedCorpses.get(player.id) : target);
    const drops: Record<string, number> = {};
    // 生物资源固定生成；未拿走的战利品原样转移，不能再次抽取掉落。
    for (const resource of corpse.resources ?? []) drops[resource.itemId] = (drops[resource.itemId] ?? 0) + resource.quantity;
    for (const [itemId, quantity] of Object.entries(corpse.inventory)) if (quantity > 0) drops[itemId] = (drops[itemId] ?? 0) + quantity;
    const ground = Object.entries(drops).map(([itemId, quantity]) => {
      const item = gameConfig.items.find(item => item.id === itemId)!;
      return { id: `drop-${randomUUID()}`, itemId, quantity, name: item.name, location: corpse.location, currencyValue: item.currencyValue };
    });
    corpse.harvested = true; corpse.inventory = {}; this.items.push(...ground);
    return { name: corpseSummary(corpse).name, items: ground };
  }
  snapshot(id: string) {
    // 不在公共状态中泄露敌人背包；只有搜刮者获得容器内容。
    const visibleEnemies = this.enemies.filter(enemy => !enemy.harvested).map(({ inventory: _inventory, ...enemy }) => enemy);
    return { type: 'state', selfId: id, players: [...this.players.values()], coinAvailable: this.coinAvailable, dummies: visibleEnemies, enemies: visibleEnemies, corpses: this.enemies.filter(isCorpse).map(corpseSummary), items: this.items.filter(item => item.quantity > 0), places };
  }
}
