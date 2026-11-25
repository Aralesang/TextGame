// 配置只描述数据与已有规则，不执行脚本或字符串表达式。
export type EquipmentSlot = 'weapon' | 'body' | 'head' | 'accessory';
export type EffectKind = 'strength' | 'magic' | 'regeneration';
export type VitalName = 'health' | 'mana' | 'satiety' | 'hydration';
export interface StatusEffect { kind: EffectKind; power: number; turns: number }
export interface ItemDefinition {
  id: string; name: string; kind: 'equipment' | 'potion' | 'consumable' | 'material'; description: string;
  slot?: EquipmentSlot; attack?: number; defense?: number; magic?: number; currencyValue?: number;
  restore?: Partial<Record<VitalName, number>>;
  effect?: EffectKind; power?: number; turns?: number;
}
export interface SkillDefinition {
  id: string; name: string; cost: number; description: string; target: 'enemy' | 'all' | 'self';
  damage?: number; multiplier?: number; heal?: number;
}
export interface MapDefinition {
  id: string; name: string; description: string; exits: string[];
  encounters?: { id: string; members: { enemyId: string; count: number }[] }[];
  groundItems: { id: string; itemId: string; quantity: number }[];
}
export interface EnemyAction { type: 'idle' | 'attack' | 'defend' | 'skill'; skill?: string; when?: { healthBelowPercent?: number; every?: number } }
export interface LootEntry { itemId: string; chance: number; min: number; max: number }
export interface ResourceEntry { itemId: string; quantity: number }
export interface EnemyDefinition {
  id: string; name: string; health: number | 'infinite';
  loot?: LootEntry[]; resources?: ResourceEntry[];
  mana: number; attack: number; defense: number; magic: number; skills: string[]; idleText: string;
  behavior: { mode: 'idle' | 'attack' | 'cycle' | 'priority'; fallback: 'idle' | 'attack'; actions: EnemyAction[] };
}
export interface WorldDefinition { startMap: string; maps: MapDefinition[] }
export interface PlayerDefinition {
  vitals: Record<VitalName, number>; coins: number; unarmedAttack: number;
  equipment: Record<EquipmentSlot, string | null>; skills: 'all' | string[];
  starterInventory: Record<ItemDefinition['kind'], number> & { items: Record<string, number> };
}
export interface GameConfig { enemies: EnemyDefinition[]; items: ItemDefinition[]; skills: SkillDefinition[]; world: WorldDefinition; player: PlayerDefinition }
