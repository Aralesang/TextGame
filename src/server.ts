import { gameConfig } from './config.js';
import http from 'node:http';
import { equipmentSummary, itemDefinitions, skillDefinitions } from './rpg.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { Game, places, type Player } from './game.js';

// 导出工厂，测试和命令行启动使用同一个真正的 HTTP/WebSocket 服务器。
export function createGameServer() {
  const game = new Game();
  // HTTP 仅保留健康检查；游戏客户端改用终端 WebSocket。
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.url === '/health' ? '文字冒险服务器运行中' : '请使用终端客户端连接。');
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  // HTTP 启动错误也会转发到 WebSocketServer，交给启动调用方处理。
  wss.on('error', () => {});
  const clients = new Map<WebSocket, Player>();
  const send = (ws: WebSocket, data: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const broadcast = (data: unknown) => clients.forEach((_, ws) => send(ws, data));
  const log = (text: string, kind = 'event') => broadcast({ type: 'message', kind, text });
  const openedViews = new Set<WebSocket>();
  const sync = () => clients.forEach((player, ws) => {
    send(ws, game.snapshot(player.id));
    const view = game.getOpenCorpse(player);
    if (view) { openedViews.add(ws); send(ws, { type: 'corpseView', view }); }
    else if (openedViews.delete(ws)) send(ws, { type: 'corpseClosed' });
  });
  wss.on('connection', ws => {
    let alive = true;
    let windowStart = Date.now(), count = 0;
    // 未入场连接限时关闭；心跳清理断网后残留的玩家。
    const joinTimer = setTimeout(() => { if (!clients.has(ws)) ws.close(1008, 'Join timeout'); }, 30000);
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 15000);
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw, binary) => {
      try {
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
        if (++count > 15) throw new Error('操作太快，请稍后再试。');
        if (binary) throw new Error('不支持此消息格式。');
        const data = JSON.parse(raw.toString());
        if (!data || typeof data !== 'object') throw new Error('无效消息。');
        const player = clients.get(ws);
        if (!player) {
          if (data.type !== 'join') throw new Error('请先输入昵称加入。');
          const joined = game.join(data.name);
          clients.set(ws, joined); clearTimeout(joinTimer);
          // 服务器配置先于状态发送，远端客户端无需手动同步本地 JSON 文件。
          send(ws, { type: 'config', config: gameConfig });
          sync(); log(`${joined.name} 进入了${places[joined.location].name}。`); send(ws, { type: 'message', kind: 'result', text: game.look(joined) }); return;
        }
        if (data.type === 'look') {
          send(ws, { type: 'message', kind: 'result', text: game.look(player) });
        } else if (data.type === 'move') {
          const old = places[player.location].name;
          game.move(player, data.target);
          sync(); log(`${player.name} 离开${old}，进入了${places[player.location].name}。`);
          send(ws, { type: 'message', kind: 'result', text: game.look(player) });
        } else if (data.type === 'attack') {
          const result = game.attack(player, data.target);
          sync();
          send(ws, { type: 'combatSequence', round: result.round, nextRound: player.combat!.round, outcome: player.combat!.outcome, lines: result.lines });
          log(result.started ? `${player.name} 攻击${result.dummy.battleName}，引起同组目标注意，进入战斗。` : `${player.name} 第${result.round}回合攻击${result.dummy.battleName}，造成 ${result.damage} 点伤害；敌方依次完成行动。`);
        } else if (data.type === 'completeCombat') {
          const text = game.completeCombat(player);
          sync(); send(ws, { type: 'message', kind: 'result', text }); log(`${player.name}：${text}`);
        } else if (data.type === 'selectTarget') {
          const text = game.selectCombatTarget(player, data.target);
          sync(); send(ws, { type: 'message', kind: 'result', text });
        } else if (data.type === 'defend') {
          const round = player.combat?.round;
          const lines = game.defend(player);
          sync(); send(ws, { type: 'combatSequence', round, nextRound: player.combat!.round, outcome: player.combat!.outcome, lines });
          log(`${player.name} 采取防御，敌方依次完成行动。`);
        } else if (['equip', 'unequip', 'useItem', 'useSkill'].includes(data.type)) {
          const round = player.combat?.round;
          const lines = data.type === 'equip' || data.type === 'unequip' ? game.changeEquipment(player, data.item, data.type === 'unequip')
            : data.type === 'useItem' ? game.useItem(player, data.item) : game.useSkill(player, data.skill, data.target);
          sync();
          if (round !== undefined) send(ws, { type: 'combatSequence', round, nextRound: player.combat!.round, outcome: player.combat!.outcome, lines });
          else lines.forEach(text => send(ws, { type: 'message', kind: 'result', text }));
          log(`${player.name}：${lines[0]}`);
        } else if (data.type === 'equipmentStatus') {
          const owned = itemDefinitions.filter(i => i.kind === 'equipment' && player.inventory[i.name] > 0);
          send(ws, { type: 'message', kind: 'result', text: equipmentSummary(player) + ' 可用装备：' + owned.map(i => `${i.name}（${i.description}）`).join('；') + '。使用「装备 名称」或「卸下 装备位」。战斗中每次更换或卸下消耗一回合。' });
        } else if (data.type === 'skillStatus') {
          send(ws, { type: 'message', kind: 'result', text: '已学技能：' + skillDefinitions.filter(s => player.skills.includes(s.id)).map(s => `${s.name}（MP ${s.cost}，${s.description}）`).join('；') + '。使用「施放 技能名 [目标]」。' });
        } else if (data.type === 'itemStatus') {
          send(ws, { type: 'message', kind: 'result', text: '消耗品：' + itemDefinitions.filter(i => (i.kind === 'potion' || i.kind === 'consumable') && player.inventory[i.name] > 0).map(i => `${i.name} ×${player.inventory[i.name]}（${i.description}）`).join('；') + '。使用「使用 物品名」。' });
        } else if (data.type === 'combatStatus') {
          send(ws, { type: 'message', kind: 'result', text: game.combatStatus(player) });
        } else if (data.type === 'leaveCombat') {
          const dummy = game.leaveCombat(player);
          sync(); send(ws, { type: 'message', kind: 'result', text: `你结束了与${dummy.battleName}等目标的练习，返回探索界面。` });
          log(`${player.name} 脱离了与${dummy.battleName}的战斗。`);
        } else if (data.type === 'searchCorpse') {
          game.searchCorpse(player, data.target); sync();
        } else if (data.type === 'closeCorpse') {
          game.closeCorpse(player); sync();
        } else if (data.type === 'takeCorpseItem' || data.type === 'takeAllCorpseItems') {
          const text = data.type === 'takeAllCorpseItems' ? game.takeAllFromCorpse(player) : game.takeFromCorpse(player, data.item, data.quantity === undefined ? 1 : data.quantity);
          sync(); send(ws, { type: 'message', kind: 'result', text: `从尸体拿取：${text}。` });
          log(`${player.name} 搜刮获得${text}。`);
        } else if (data.type === 'decomposeCorpse') {
          const result = game.decomposeCorpse(player, data.target);
          sync();
          const text = result.items.length ? result.items.map(item => `${item.name} ×${item.quantity}`).join('、') : '无';
          send(ws, { type: 'message', kind: 'result', text: `已分解${result.name}。地面散落：${text}。` });
          log(`${player.name} 分解了${result.name}，资源和剩余物品已散落地面。`);
        } else if (data.type === 'pickup') {
          const item = game.pickup(player, data.target);
          sync(); log(`${player.name} 在${places[player.location].name}拾取了${item.name} ×1。`);
          send(ws, { type: 'message', kind: 'result', text: `获得：${item.name} ×1。` });
        } else if (data.type === 'chat') {
          if (typeof data.text !== 'string' || !data.text.trim() || [...data.text].length > 200 || /[\p{Cc}\p{Cf}]/u.test(data.text)) throw new Error('聊天内容须为 1～200 个可见字符。');
          log(`${player.name}：${data.text.trim()}`, 'chat');
        } else throw new Error('未知操作。');
      } catch (error) { send(ws, { type: 'error', text: error instanceof SyntaxError ? '无效消息格式。' : error instanceof Error ? error.message : '操作失败。' }); }
    });
    ws.on('close', () => {
      clearTimeout(joinTimer); clearInterval(heartbeat); openedViews.delete(ws);
      const player = clients.get(ws);
      if (player) { clients.delete(ws); game.removePlayer(player.id); sync(); log(`${player.name} 离开了世界。`); }
    });
  });
  return { server, wss, game, close: async () => {
    wss.clients.forEach(ws => ws.terminate());
    await new Promise<void>(r => wss.close(() => r()));
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const multiplayer = process.argv.includes('--multiplayer');
  const host = multiplayer ? '0.0.0.0' : '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1～65535。');
  const app = createGameServer();
  app.server.on('error', error => { console.error(`服务器启动失败：${error.message}`); process.exitCode = 1; });
  app.server.listen(port, host, () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    console.log(`\n文字冒险 · ${multiplayer ? '多人模式' : '单人模式'}\n本机：${url}`);
    if (multiplayer) for (const list of Object.values(networkInterfaces())) for (const address of list ?? []) if (address.family === 'IPv4' && !address.internal) console.log(`局域网：ws://${address.address}:${port}/ws`);
    console.log('世界暂不存档，重启会重置。按 Ctrl+C 关闭。\n');

  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
