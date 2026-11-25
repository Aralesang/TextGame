import type { Player } from "./game.js";

import { gameConfig } from "./config.js";
import type {
  EquipmentSlot,
  EffectKind,
  StatusEffect,
  ItemDefinition,
} from "./config-types.js";
export type {
  EquipmentSlot,
  EffectKind,
  StatusEffect,
  ItemDefinition,
  SkillDefinition,
} from "./config-types.js";

// 客户端说明与服务器计算共用启动时加载、或联网后同步的配置。
export const slotNames: Record<EquipmentSlot, string> = {
  weapon: "武器",
  body: "护甲",
  head: "头盔",
  accessory: "饰品",
};
export const itemDefinitions = gameConfig.items;
export const skillDefinitions = gameConfig.skills;
export const effectNames: Record<EffectKind, string> = {
  strength: "力量提升",
  magic: "魔力提升",
  regeneration: "生命再生",
};
export function initialRpgState() {
  return {
    equipment: { ...gameConfig.player.equipment },
    skills:
      gameConfig.player.skills === "all"
        ? skillDefinitions.map((s) => s.id)
        : [...gameConfig.player.skills],
    effects: [] as StatusEffect[],
  };
}
export function starterInventory(): Record<string, number> {
  const starter = gameConfig.player.starterInventory;
  return Object.fromEntries(
    itemDefinitions
      .map((item) => [item.name, starter.items[item.id] ?? starter[item.kind]])
      .filter(([, count]) => Number(count) > 0),
  );
}

export const itemById = (id: string | null) =>
  itemDefinitions.find((item) => item.id === id);
export function resolveItem(value: unknown) {
  if (typeof value !== "string") throw new Error("请指定物品名称。");
  const item = itemDefinitions.find(
    (item) => item.id === value.trim() || item.name === value.trim(),
  );
  if (!item) throw new Error("没有这种物品，请查看背包或装备列表。");
  return item;
}
export function stats(player: Player) {
  const items = Object.values(player.equipment)
    .map(itemById)
    .filter((i): i is ItemDefinition => !!i);
  return {
    attack:
      (player.equipment.weapon ? 0 : gameConfig.player.unarmedAttack) +
      items.reduce((n, i) => n + (i.attack ?? 0), 0) +
      player.effects
        .filter((e) => e.kind === "strength")
        .reduce((n, e) => n + e.power, 0),
    defense: items.reduce((n, i) => n + (i.defense ?? 0), 0),
    magic:
      items.reduce((n, i) => n + (i.magic ?? 0), 0) +
      player.effects
        .filter((e) => e.kind === "magic")
        .reduce((n, e) => n + e.power, 0),
  };
}
export function equipmentSummary(player: Player) {
  const s = stats(player);
  return (
    Object.entries(slotNames)
      .map(
        ([slot, name]) =>
          `${name}：${itemById(player.equipment[slot as EquipmentSlot])?.name ?? "无"}`,
      )
      .join("；") + `。攻击 ${s.attack} / 防御 ${s.defense} / 魔法 ${s.magic}。`
  );
}
// 装备仍保留在背包中，装备位只引用物品；更换不会复制或吞掉旧装备。
export function equip(player: Player, value: unknown) {
  const item = resolveItem(value);
  if (item.kind !== "equipment" || !item.slot)
    throw new Error("该物品不能装备。");
  if (!(player.inventory[item.name] > 0))
    throw new Error("背包中没有这件装备。");
  if (player.equipment[item.slot] === item.id)
    throw new Error("已经装备了这件物品。");
  const previous = itemById(player.equipment[item.slot])?.name ?? "无";
  player.equipment[item.slot] = item.id;
  return `更换${slotNames[item.slot]}：${previous} → ${item.name}（${item.description}）。`;
}
export function unequip(player: Player, value: unknown) {
  const slot = Object.entries(slotNames).find(
    ([id, name]) => id === value || name === value,
  )?.[0] as EquipmentSlot | undefined;
  if (!slot || !player.equipment[slot])
    throw new Error("该装备位没有可卸下的装备。");
  const name = itemById(player.equipment[slot])!.name;
  player.equipment[slot] = null;
  return `卸下${slotNames[slot]}：${name}。`;
}
export function drink(player: Player, value: unknown) {
  const item = resolveItem(value);
  if (item.kind !== "potion" && item.kind !== "consumable")
    throw new Error("该物品不是可使用的消耗品。");
  if (!(player.inventory[item.name] > 0))
    throw new Error("背包中没有该消耗品。");
  const labels = {
    health: "生命",
    mana: "法力",
    satiety: "饱食度",
    hydration: "水分",
  };
  const gains = Object.entries(item.restore ?? {}).map(([key, amount]) => ({
    key: key as keyof Player["vitals"],
    amount: Math.min(
      amount,
      100 - player.vitals[key as keyof Player["vitals"]],
    ),
  }));
  if (!item.effect && gains.every((g) => g.amount <= 0))
    throw new Error("相关属性已满，不需要使用消耗品。");
  if (item.effect && !player.combat)
    throw new Error("增益消耗品请在战斗中使用。");
  player.inventory[item.name] -= 1;
  gains.forEach((g) => {
    player.vitals[g.key] += g.amount;
  });
  if (item.effect) {
    player.effects = player.effects.filter(
      (effect) => effect.kind !== item.effect,
    );
    player.effects.push({
      kind: item.effect,
      power: item.power!,
      turns: item.turns!,
    });
  }
  return {
    line: `使用${item.name}：${[...gains.map((g) => `${labels[g.key]} +${g.amount}`), ...(item.effect ? [`${effectNames[item.effect]}，持续后续 ${item.turns} 次行动`] : [])].join("，")}。`,
    skipEffect: item.effect,
  };
}
export interface BattleOption {
  label: string;
  description: string;
  command: string;
  needsTarget?: boolean;
  disabled?: string;
}
export function battleOptions(
  player: Player,
  category: string,
): BattleOption[] {
  if (category === "skills")
    return skillDefinitions
      .filter((s) => player.skills.includes(s.id))
      .map((s) => ({
        label: `${s.name} MP${s.cost}`,
        description: s.description,
        command: `施放 ${s.id}`,
        needsTarget: s.target === "enemy",
        disabled: player.vitals.mana < s.cost ? "法力不足" : undefined,
      }));
  if (category === "items")
    return itemDefinitions
      .filter(
        (i) =>
          (i.kind === "potion" || i.kind === "consumable") &&
          player.inventory[i.name] > 0,
      )
      .map((i) => ({
        label: `${i.name} ×${player.inventory[i.name]}`,
        description: i.description,
        command: `使用 ${i.id}`,
      }));
  if (category === "equipment")
    return itemDefinitions
      .filter((i) => i.kind === "equipment" && player.inventory[i.name] > 0)
      .map((i) => ({
        label: `${i.name}${player.equipment[i.slot!] === i.id ? " [已装备]" : ""}`,
        description: `${slotNames[i.slot!]}；${i.description}；更换消耗一回合`,
        command: `装备 ${i.id}`,
        disabled:
          player.equipment[i.slot!] === i.id ? "已装备该物品" : undefined,
      }));
  return [];
}
