import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { gameConfig, applyGameConfig } from '../src/config.js';
import { createGameServer } from '../src/server.js';

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('等待普通敌人同步超时'); await new Promise(r => setTimeout(r, 10)); }
};
// 每个测试使用独立服务器，修改配置不会影响其他用例。
async function server(health: number, run: (app: ReturnType<typeof createGameServer>, url: string) => Promise<void>) {
  const original = structuredClone(gameConfig), config = structuredClone(gameConfig);
  const rat = config.enemies.find(e => e.id === 'forest_rat')!;
  Object.assign(rat, { health, defense: 0, attack: 999, skills: [], behavior: { mode: 'attack', fallback: 'attack', actions: [] } });
  applyGameConfig(config);
  const app = createGameServer();
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert(address && typeof address === 'object');
    await run(app, `ws://127.0.0.1:${address.port}/ws`);
  } finally { await app.close(); applyGameConfig(original); }
}
async function connect(url: string, name: string) {
  const ws = new WebSocket(url), messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (data: unknown) => ws.send(JSON.stringify(data));
  send({ type: 'join', name }); send({ type: 'move', target: 'forest' });
  await until(() => messages.some(m => m.type === 'state' && m.players.some((p: any) => p.id === m.selfId && p.location === 'forest')));
  return { ws, messages, send };
}

test('联机锁定、死亡同步、胜利结算且不能重复击杀', async () => server(9, async (app, url) => {
  const a = await connect(url, '甲'), b = await connect(url, '乙');
  a.send({ type: 'attack', target: 'forest_rat' });
  await until(() => app.game.enemies.find(e => e.templateId === 'forest_rat')!.engagedBy !== null);
  b.send({ type: 'attack', target: 'forest_rat' });
  await until(() => b.messages.some(m => m.type === 'error' && m.text.includes('其他玩家')));
  a.send({ type: 'attack', damage: 99999 });
  await until(() => a.messages.some(m => m.type === 'combatSequence' && m.outcome === 'victory'));
  await until(() => b.messages.some(m => m.type === 'state' && m.dummies.find((e: any) => e.templateId === 'forest_rat').health === 0));
  const player = [...app.game.players.values()].find(p => p.name === '甲')!;
  assert.equal(player.vitals.health, 100);
  a.send({ type: 'completeCombat' });
  await until(() => player.combat === null);
  a.send({ type: 'completeCombat' }); b.send({ type: 'attack', target: 'forest_rat' });
  await until(() => a.messages.some(m => m.type === 'error' && m.text.includes('尚未结束')) && b.messages.some(m => m.type === 'error' && m.text.includes('倒下')));
  assert.equal(app.game.enemies.find(e => e.templateId === 'forest_rat')!.hits, 1);
}));

test('联机战败、出生点恢复及断线释放遭遇', async () => server(200, async (app, url) => {
  const a = await connect(url, '甲'), b = await connect(url, '乙');
  a.send({ type: 'attack', target: 'forest_rat' }); a.send({ type: 'defend' });
  await until(() => a.messages.some(m => m.type === 'combatSequence' && m.outcome === 'defeat'));
  await until(() => b.messages.some(m => m.type === 'state' && m.players.some((p: any) => p.name === '甲' && p.vitals.health === 0)));
  a.send({ type: 'completeCombat' });
  const player = [...app.game.players.values()].find(p => p.name === '甲')!;
  await until(() => player.combat === null);
  assert.equal(player.vitals.health, 100); assert.equal(player.location, 'camp');
  b.send({ type: 'attack', target: 'forest_rat' });
  const rat = app.game.enemies.find(e => e.templateId === 'forest_rat')!;
  await until(() => rat.engagedBy !== null);
  b.ws.close(); await until(() => rat.engagedBy === null);
}));

test('文字客户端收到胜利后自动结算并退出战斗', { timeout: 10000 }, async () => server(9, async (app, url) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--connect', url, '--name', '自动结算'], { stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { output += data.toString(); });
  try {
    await until(() => app.game.players.size === 1);
    child.stdin.write('前往 森林\n攻击 森林鼠\n攻击\n');
    await until(() => output.includes('战斗胜利，返回探索。'));
    const player = [...app.game.players.values()][0]; assert.equal(player.combat, null);
    child.stdin.write('退出\n'); await until(() => child.exitCode !== null); assert.equal(child.exitCode, 0);
  } finally { child.kill('SIGKILL'); }
}));
