import type { BattleOption } from './rpg.js';
export const battleActions = ['攻击', '技能', '道具', '装备', '防御', '逃跑'];
// 战斗演出与服务器规则分离：服务端一次结算，客户端自动逐条播放，避免整轮消息瞬间刷走。
export type BattleMode = 'menu' | 'target' | 'waiting' | 'narration' | 'skills' | 'items' | 'equipment';
export class BattleFlow {
  mode: BattleMode = 'menu';
  menuIndex = 0;
  targetIndex = 0;
  optionIndex = 0;
  options: BattleOption[] = [];
  private pendingCommand = '攻击';
  private targetReturn: BattleMode = 'menu';
  message = '你要怎么做？';
  round = 1;
  history: string[] = [];
  private record(message: string) { this.history.push(message); this.history = this.history.slice(-500); }
  private frames: string[] = [];
  private nextRound = 1;
  private completed?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private changed: () => void = () => {}, private frameDelay = 1100) {}
  // 离场、出错或开始新序列前取消旧计时，避免旧战斗回调覆盖当前界面。
  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.completed = undefined; }
  private schedule() {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.mode !== 'narration') return;
      const frame = this.frames.shift();
      if (frame !== undefined) {
        this.message = frame;
        this.record(frame);
        const next = /^第(\d+)回合，轮到你行动/u.exec(frame);
        if (next) this.round = Number(next[1]);
        this.schedule();
      } else {
        const completed = this.completed; this.completed = undefined;
        this.mode = completed ? 'waiting' : 'menu'; this.round = this.nextRound; this.message = completed ? '战斗结束，正在返回探索。' : '你要怎么做？';
        if (completed) { this.changed(); completed(); return; }
      }
      this.changed();
    }, this.frameDelay);
  }
  start(round: number, targetIndex: number) {
    this.dispose();
    this.history = [];
    this.round = round; this.targetIndex = Math.max(0, targetIndex);
    this.mode = 'menu'; this.menuIndex = 0; this.optionIndex = 0; this.options = []; this.pendingCommand = '攻击'; this.targetReturn = 'menu'; this.frames = []; this.message = '你要怎么做？';
  }
  present(lines: string[], round: number, nextRound: number, completed?: () => void) {
    this.dispose();
    this.completed = completed;
    this.frames = [...lines]; this.round = round; this.nextRound = nextRound;
    this.mode = 'narration'; this.message = this.frames.shift() ?? '行动结束。';
    this.record(this.message);
    this.schedule();
  }
  fail(message: string) { this.record(message); this.dispose(); this.frames = []; this.mode = 'menu'; this.message = message; }
  wait() { this.dispose(); this.mode = 'waiting'; this.message = '正在等待服务器结算……'; }
  // 返回需要提交的动作；切换菜单与本地选择目标本身不提交游戏操作。
  key(name: string, text: string | undefined, enemyIds: string[], aliveIds = enemyIds): string | undefined {
    if (this.mode === 'waiting') return;
    if (this.mode === 'narration') return;
    if (this.mode === 'target') {
      if (name === 'escape') { this.mode = this.targetReturn; this.message = '请选择行动。'; return; }
      const alive = enemyIds.map((id, i) => aliveIds.includes(id) ? i : -1).filter(i => i >= 0);
      if (!alive.length) return;
      if (!alive.includes(this.targetIndex)) this.targetIndex = alive[0];
      if (['left', 'up', 'right', 'down'].includes(name)) this.targetIndex = alive[(alive.indexOf(this.targetIndex) + (name === 'left' || name === 'up' ? -1 : 1) + alive.length) % alive.length];
      if (text && /^[1-9]$/.test(text) && alive.includes(Number(text) - 1)) this.targetIndex = Number(text) - 1;
      if (text === '0' && alive.includes(9)) this.targetIndex = 9;
      if (name === 'space' || text === ' ') { const target = enemyIds[this.targetIndex]; if (target) { this.wait(); return `${this.pendingCommand} ${target}`; } }
      return;
    }
    if (this.mode === 'skills' || this.mode === 'items' || this.mode === 'equipment') {
      if (name === 'escape') { this.mode = 'menu'; this.message = '你要怎么做？'; return; }
      if (!this.options.length) { this.message = '没有可用选项。按 Esc 返回。'; return; }
      if (name === 'up' || name === 'down') this.optionIndex = (this.optionIndex + (name === 'up' ? -1 : 1) + this.options.length) % this.options.length;
      if (text && /^[1-9]$/.test(text)) this.optionIndex = Math.min(this.options.length - 1, Number(text) - 1);
      if (name === 'space' || text === ' ') {
        const option = this.options[this.optionIndex];
        if (option.disabled) { this.message = option.disabled; return; }
        if (option.needsTarget) { this.targetReturn = this.mode; this.pendingCommand = option.command; this.mode = 'target'; this.message = '选择技能目标。'; }
        else { this.wait(); return option.command; }
      }
      return;
    }
    if (['up', 'down', 'left', 'right'].includes(name)) {
      const delta = name === 'up' ? -2 : name === 'down' ? 2 : name === 'left' ? -1 : 1;
      this.menuIndex = (this.menuIndex + delta + battleActions.length) % battleActions.length;
    }
    if (text && /^[1-6]$/.test(text)) this.menuIndex = Number(text) - 1;
    if (name === 'space' || text === ' ') {
      if (this.menuIndex === 0) { this.targetReturn = 'menu'; this.pendingCommand = '攻击'; this.mode = 'target'; this.message = '攻击哪个敌人？'; }
      else if (this.menuIndex <= 3) {
        this.mode = (['skills', 'items', 'equipment'] as const)[this.menuIndex - 1];
        this.optionIndex = 0; this.options = []; this.message = this.mode === 'equipment' ? '更换任何装备消耗一回合。' : '选择选项，空格确认，Esc 返回。';
      } else { const command = this.menuIndex === 4 ? '防御' : '脱离战斗'; this.wait(); return command; }
    }
  }
}
