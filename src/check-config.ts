import { gameConfig } from './config.js';
// 可独立运行的静态配置检查，不启动服务器或玩家客户端。
console.log(`配置检查通过：${gameConfig.items.length} 个物品，${gameConfig.skills.length} 个技能，${gameConfig.world.maps.length} 张地图，${gameConfig.enemies.length} 种敌人定义，${gameConfig.world.maps.flatMap(map => map.encounters ?? []).reduce((total, encounter) => total + encounter.members.reduce((sum, member) => sum + member.count, 0), 0)}个场景敌人实例。`);
