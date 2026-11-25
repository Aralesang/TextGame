# 游戏配置说明

修改本目录的 JSON 就能在现有规则内新增或调整物品、装备、技能、地图和初始角色。不需要修改 TypeScript，也不需要重新编译；**保存配置后重启服务器**，已连接的客户端重新连接。当前世界仍不存档，重启会重置世界。

| 文件 | 内容 |
| --- | --- |
| `items.json` | 所有物品：武器、护甲、头盔、饰品、消耗品、材料、货币 |
| `skills.json` | 技能名称、法力消耗、单体/全体/自身目标与伤害/治疗 |
| `world.json` | 出生地图、地图出口、地面物品与敌方编组/数量 |
| `enemies.json` | 敌人种类的属性、技能与行动规则 |
| `player.json` | 初始属性、装备、已学技能、背包发放规则 |

检查配置：

```sh
npm run config:check
```

启动服务器时也会自动检查。错误会指出文件与字段，例如 `items.json[2].slot`。JSON 不支持注释和末尾多余逗号，说明文字请写在 `description`。

所有引用使用稳定的 `id`，不要用显示名称关联数据。ID 以小写英文字母开头，只使用小写字母、数字、下划线或连字符。名称支持中文；同类定义中的 ID、名称不能互相重复。改 ID 时同步修改引用；只改 `name` 不影响配置关联。

## 1. 物品：items.json

文件是一个数组，新增物品时向数组追加对象。所有物品必填 `id`、`name`、`kind`、`description`。

`kind` 支持：

- `equipment`：装备。
- `consumable`：消耗品。旧分类 `potion` 同样支持，现有药水保留这个分类。
- `material`：普通材料或拾取货币。

### 装备示例

```json
{
  "id": "silver_blade",
  "name": "银剑",
  "kind": "equipment",
  "description": "物理攻击24，附加魔法强度3",
  "slot": "weapon",
  "attack": 24,
  "magic": 3
}
```

| 字段 | 含义 |
| --- | --- |
| `slot` | 必填：`weapon` 武器、`body` 护甲、`head` 头盔、`accessory` 饰品 |
| `attack` | 可选，物理攻击；所有已装备物品的该数值相加 |
| `defense` | 可选，防御加成 |
| `magic` | 可选，魔法强度加成 |

四个槽位各装备一件物品。未持有不能装备，重复装备不耗回合。装备本体保留在背包，更换不会复制或销毁。武器位为空时，基础物理攻击使用 `player.json` 的 `unarmedAttack`。战斗内更换或卸下任意槽位消耗一回合，战斗外不消耗。

### 恢复消耗品示例

```json
{
  "id": "bread",
  "name": "面包",
  "kind": "consumable",
  "description": "恢复饱食度30和生命5",
  "restore": { "satiety": 30, "health": 5 }
}
```

`restore` 可以组合：`health` 生命、`mana` 法力、`satiety` 饱食、`hydration` 水分。每个恢复量为0～100，恢复后不超过100；全部相关属性已满时不扣物品、不耗回合。

### 持续效果消耗品示例

```json
{
  "id": "strong_tonic",
  "name": "强效力量药剂",
  "kind": "consumable",
  "description": "恢复生命10，后续5次行动物理攻击加12",
  "restore": { "health": 10 },
  "effect": "strength",
  "power": 12,
  "turns": 5
}
```

| effect | power 的作用 |
| --- | --- |
| `strength` | 增加物理攻击 |
| `magic` | 增加魔法强度 |
| `regeneration` | 每次自身行动后恢复对应数量的生命 |

持续效果必须同时提供正数 `power` 与1～1000的整数 `turns`，可与 `restore` 组合。同类效果刷新、不叠加，不同效果共存。新效果从后续行动开始计次，喝药当次不会立即扣一次；其他已有效果照常推进。战斗结束清除效果。带持续效果的消耗品只能在战斗中使用。

### 材料与货币

```json
{
  "id": "copper_coin",
  "name": "铜币",
  "kind": "material",
  "description": "拾取后增加2金币",
  "currencyValue": 2
}
```

普通材料省略 `currencyValue`。只有材料可配置这个字段；每拾取一个增加对应金币数，同时保留背包中的物品数量。

## 2. 技能：skills.json

同样是对象数组。必填 `id`、`name`、`description`、`cost`、`target`。`cost` 为非负整数。

### 固定基础魔法伤害

```json
{
  "id": "ice_bolt",
  "name": "冰箭",
  "description": "对单个敌人造成22加魔法强度的伤害",
  "cost": 9,
  "target": "enemy",
  "damage": 22
}
```

实际伤害为 `damage + 当前魔法强度`，包含装备与增益效果。

### 物理倍率技能

```json
{
  "id": "cleave",
  "name": "强力横斩",
  "description": "对全部敌人造成1.2倍物理攻击伤害",
  "cost": 18,
  "target": "all",
  "multiplier": 1.2
}
```

实际对每个目标造成 `floor(当前物理攻击 × multiplier)`，最低1点。`enemy` 为单体，需要选择目标；`all` 为本场全部敌人，不需要逐个选择。伤害技能的 `damage` 与 `multiplier` 必须二选一，不能同时填写。

### 自身治疗

```json
{
  "id": "greater_heal",
  "name": "强效治疗",
  "description": "恢复自身生命60",
  "cost": 16,
  "target": "self",
  "heal": 60
}
```

`self` 必须配置 `heal`（1～100），不能配置伤害字段。生命满时不扣法力、不耗回合。技能需已学习；法力不足、目标无效等错误均不扣资源。战斗内施放技能消耗一回合；攻击技能仅限战斗，自身治疗也可在战斗外使用。

目前支持上述伤害、治疗与三类持续效果规则，不支持填写 JavaScript 或自由公式。新增独立机制（例如召唤、冻结、反伤）仍需先扩展对应的规则处理器；上述规则内的数值与组合可直接配置。

## 3. 地图：world.json

| 顶层字段 | 含义 |
| --- | --- |
| `startMap` | 新角色出生地图 ID |
| `maps` | 地图数组 |


向 `maps` 追加一个地点：

```json
{
  "id": "lake",
  "name": "湖畔",
  "description": "清澈的湖水映着天空。",
  "exits": ["camp"],
  "groundItems": [
    { "id": "lake_bread", "itemId": "bread", "quantity": 3 }
  ]
}
```

先在 `items.json` 定义 `bread`。`groundItems[].id` 是地面物品堆的独立 ID，需在整个世界中唯一；`itemId` 引用物品定义；`quantity` 为正整数。每次拾取一个。可用显示名称或物品堆 ID 拾取；同一地图放置多堆同名物品时，按名称优先拾取尚未取空的物品堆。

**出口是有方向的。** `lake.exits` 中有 `camp` 只表示可以从湖畔前往营地。如需营地也能去湖畔，要在营地的 `exits` 中追加 `"lake"`。服务器只允许沿当前地图出口移动。移动命令、地图显示与「查看」中的出口会自动生成，无需改脚本。

### 敌方编组与放置数量

在地图对象里添加可选的 `encounters` 数组。未填写时该地图没有敌人。

```json
"encounters": [
  {
    "id": "dummy",
    "members": [
      { "enemyId": "training_dummy", "count": 2 }
    ]
  }
]
```

`enemyId` 引用 `enemies.json` 中的一条种类定义，`count` 为数量。同种敌人只写一次，通过数量生成独立实例，不要复制定义并取名「木桩1」「木桩2」。上例在地图上显示「木桩 ×2」，进入战斗后自动显示「木桩 A」「木桩 B」；若只放1只，就显示「木桩」，不加后缀。每个实例各自保存生命、法力与行动计数，修改一只不影响另一只。

同一编组一起参战，不同编组不联动；编组 `id` 在整个世界中唯一，每组最多10只，可混合多种敌人。编组内后缀按出现顺序分配，死亡后保留原标识，避免选择目标时混淆。数字选择、方向键与空格确认均保持原有操作方式。

## 4. 初始角色：player.json

- `vitals`：四个属性初值，生命为1～100，其他为0～100，上限固定为100。
- `coins`：初始金币。
- `unarmedAttack`：空手攻击基础值。
- `equipment`：四个槽位的物品 ID，空置填写 `null`。配置的初始装备必须同时持有且槽位正确。
- `skills`：`"all"` 自动学会所有配置技能；也可以改为技能 ID 数组，如 `["heavy_strike", "heal"]`。
- `starterInventory`：按物品分类统一发放数量，`items` 可按 ID 覆盖某个物品的数量。

例如只给每件装备1件，每种消耗品2份，另外放5个面包、不发铜币：

```json
{
  "equipment": 1,
  "potion": 2,
  "consumable": 2,
  "material": 0,
  "items": { "bread": 5, "copper_coin": 0 }
}
```

这段替换的是 `player.json.starterInventory`，不是整个文件。`items` 中的数量是覆盖值，不是额外叠加。默认配置会发每件装备1件、每种药水或消耗品3份、材料0份，并学会全部技能；因此新增装备、消耗品和技能后可直接用新角色测试。想让物品只通过地图获取，可在此把该物品初始数量设为0，再放到 `world.json` 的地面物品中。

## 5. 敌人定义：enemies.json

文件是数组，每个对象只定义一种敌人。位置和数量在地图编组里配置，本文件不再填写 `location`、`group`。

```json
{
  "id": "slime",
  "name": "史莱姆",
  "health": 60,
  "mana": 30,
  "attack": 12,
  "defense": 2,
  "magic": 3,
  "skills": ["fireball", "heal"],
  "idleText": "停在原地观察着你。",
  "behavior": {
    "mode": "priority",
    "fallback": "attack",
    "actions": [
      { "type": "skill", "skill": "heal", "when": { "healthBelowPercent": 40 } },
      { "type": "skill", "skill": "fireball", "when": { "every": 3 } }
    ]
  }
}
```

追加这个对象后，在任意地图的编组里引用 `{ "enemyId": "slime", "count": 2 }`，即可生成两只独立的史莱姆，战斗中显示「史莱姆 A/B」。

| 字段 | 含义 |
| --- | --- |
| `id` / `name` | 种类唯一ID / 基础名称，不需要手写A/B后缀 |
| `health` | 1～1000000整数，或 `"infinite"` 表示无限生命 |
| `mana` | 初始与最大法力 |
| `attack` / `defense` / `magic` | 非负整数，物理攻击、防御、魔法强度 |
| `skills` | 已掌握技能ID，引用 `skills.json`，可为空 |
| `idleText` | 待机时跟在敌人名称后的动作描述 |
| `behavior` | 行动规则，见下表 |

| behavior.mode | 行为 |
| --- | --- |
| `idle` | 始终待机，不反击；适用于木桩 |
| `attack` | 每次普攻 |
| `cycle` | 按 `actions` 顺序循环，适合固定攻击节奏 |
| `priority` | 从前到后选择第一个可执行的规则，适合低血量治疗等 |

`fallback` 只能是 `attack` 或 `idle`。技能没蓝、治疗时生命已满或不满足触发条件时，循环模式执行后备行动；优先级模式继续查找下一条，没有可执行项才执行后备行动。`idle` 和 `attack` 模式的 `actions` 可以为空，其他模式至少配置一项。

行动 `type` 支持 `attack` 普攻、`defend` 防御、`skill` 技能、`idle` 待机。技能行动必须填写 `skill`，且该ID必须在敌人自己的 `skills` 中。技能数值和消耗沿用 `skills.json`，自身治疗作用于敌人自己，单体/群体攻击当前都作用于本场唯一玩家。

`when` 可省略，或组合：

- `healthBelowPercent`：当前生命百分比小于等于该数值时触发；无限生命目标不满足此条件。
- `every`：每累计N次敌方自身行动触发一次。计数与循环位置在本次服务器内存中保留，不因逃跑重新开始。

普攻伤害为攻击减防御后向下取整，最低1。固定基础魔法伤害加魔法强度，再减一半目标防御，最低1。玩家防御会把本轮全部敌方伤害再减半，最低1；敌人防御会对下一次玩家行动起相同作用。倒下的敌人立即停止行动，不能被继续选中；群体技能只命中存活目标。

所有敌人倒下即胜利，本轮不再反击。玩家生命归零即失败，后续敌人停止行动；播报结束自动回出生点，恢复 `player.json` 的初始属性，不扣背包、装备和金币。敌人倒下后留下尸体，可搜刮或分解；目前没有经验和自动刷新，敌人及尸体状态重启服务器后重置。

普通敌人编组每次只能由一位玩家推进，防止多人同时结算同一个有限生命目标。逃跑、离开地图、结算或断线会释放占用。全组均为无限生命且只待机时，继续允许多人独立练习。

## 尸体、随机战利品与固定资源

在敌人定义中添加以下可选字段（省略相当于空数组）：

```json
"loot": [
  { "itemId": "coin", "chance": 0.65, "min": 1, "max": 4 },
  { "itemId": "health_potion", "chance": 0.3, "min": 1, "max": 1 }
],
"resources": [
  { "itemId": "raw_meat", "quantity": 2 },
  { "itemId": "bone", "quantity": 1 }
]
```

`loot` 是敌人的初始背包生成规则。每个实例生成时，各条独立判定一次；`chance` 为 0～1，命中后在包含两端的整数区间 `min`～`max` 中抽取数量。逃跑、再次交战、死亡和重复搜刮均不会重新抽取。背包在搜刮前不通过地图状态公开。

`resources` 是分解必定产生的固定资源，`quantity` 为正整数。两类条目的 `itemId` 均引用 `items.json`；材料可定义为 `kind: "material"`。同种物品会合并数量。

战斗结算后使用 `搜刮 森林鼠` 打开共享尸体容器，方向键选择、空格拿取，也可输入 `拿取 金币 2`、`拿取 金币 全部`、`全部拿取`。搜刮不会移除尸体。使用 `分解 森林鼠`（已打开时可只输入 `分解`）会移除尸体，将固定资源和背包中剩余物品散落在当前地图，再用 `查看` 和 `拾取 物品名` 收集。多个尸体重名时，可使用地图列出的实例 ID。分解后不能重复领取，其他玩家打开的同一容器会同步关闭。

## 运行与联机

所有文件通过校验后重启服务器。编译版运行时也读取项目根目录的 `config/`，发布时保留该目录。配置路径按程序位置查找，不要求当前工作目录是项目目录。

也可指定另一套完整配置目录（含五个 JSON）：

```sh
TEXTGAME_CONFIG_DIR=/绝对路径/另一套配置 npm run server
TEXTGAME_CONFIG_DIR=/绝对路径/另一套配置 npm start
```

联机以服务器配置为准。客户端入场时自动收到整套配置，因此房主新增地图、物品或技能后，其他玩家无需手动修改本地 JSON；只需使用支持本协议的客户端重新连接。配置不热重载，正在运行的服务器不会因文件保存而改变规则。
