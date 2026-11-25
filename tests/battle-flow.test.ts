import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattleFlow } from '../src/battle-flow.js';

// 自动播报需覆盖所有行动，键盘不能跳过结果或重复提交动作。
test('菜单与目标统一空格确认，行动结果自动逐条播放', async () => {
  const seen: string[] = [];
  const flow = new BattleFlow(() => seen.push(flow.message), 20), enemies = ['dummy-1', 'dummy-2'];
  try {
    flow.start(1, 0);
    flow.key('return', undefined, enemies);
    assert.equal(flow.mode, 'menu');
    flow.key('space', ' ', enemies);
    assert.equal(flow.mode, 'target');
    flow.key('right', undefined, enemies);
    assert.equal(flow.targetIndex, 1);
    assert.equal(flow.key('return', undefined, enemies), undefined);
    assert.equal(flow.mode, 'target');
    assert.equal(flow.key('space', ' ', enemies), '攻击 dummy-2');
    assert.equal(flow.mode, 'waiting');
    assert.equal(flow.key('space', ' ', enemies), undefined);
    flow.present(['你攻击木桩 B，造成10点伤害。', '木桩 A的回合：一动不动。', '木桩 B的回合：一动不动。', '第2回合，轮到你行动。'], 1, 2);
    flow.key('space', ' ', enemies);
    flow.key('return', undefined, enemies);
    assert.match(flow.message, /你攻击木桩 B/);
    assert.deepEqual(flow.history, ['你攻击木桩 B，造成10点伤害。']);
    await new Promise<void>((resolve, reject) => {
      const end = Date.now() + 2000;
      const timer = setInterval(() => {
        if (flow.mode === 'menu') { clearInterval(timer); resolve(); }
        else if (Date.now() > end) { clearInterval(timer); reject(new Error('自动播报超时')); }
      }, 10);
    });
    assert.deepEqual(seen, ['木桩 A的回合：一动不动。', '木桩 B的回合：一动不动。', '第2回合，轮到你行动。', '你要怎么做？']);
    assert.equal(flow.round, 2);
    assert.deepEqual(flow.history, ['你攻击木桩 B，造成10点伤害。', '木桩 A的回合：一动不动。', '木桩 B的回合：一动不动。', '第2回合，轮到你行动。']);
    flow.key('down', undefined, enemies);
    flow.key('down', undefined, enemies);
    assert.equal(flow.key('space', ' ', enemies), '防御');
    flow.present(['第2回合，你防御。', '木桩 A一动不动。'], 2, 3);
    assert.equal(flow.history.length, 5);
    assert.equal(flow.history[0], '你攻击木桩 B，造成10点伤害。');
  } finally { flow.dispose(); }
});

test('取消、逃跑和离场清理旧播报计时', async () => {
  const seen: string[] = [];
  const flow = new BattleFlow(() => seen.push(flow.message), 10), enemies = ['dummy-1', 'dummy-2'];
  try {
    flow.start(1, 0);
    flow.key('space', ' ', enemies);
    flow.key('', '2', enemies);
    assert.equal(flow.targetIndex, 1);
    flow.key('escape', undefined, enemies);
    assert.equal(flow.mode, 'menu');
    flow.key('left', undefined, enemies);
    assert.equal(flow.key('space', ' ', enemies), '脱离战斗');
    flow.present(['旧消息', '不应出现的消息'], 1, 2);
    flow.start(1, 0);
    await new Promise(r => setTimeout(r, 40));
    assert.equal(flow.mode, 'menu');
    assert.deepEqual(seen, []);
    flow.present(['旧消息', '不应出现的消息'], 1, 2);
    flow.fail('连接异常');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(flow.message, '连接异常');
    assert.deepEqual(seen, []);
  } finally { flow.dispose(); }
});
