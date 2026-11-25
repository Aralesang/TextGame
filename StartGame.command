#!/bin/zsh
# 双击启动单窗口分区界面。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print '请先安装 Node.js 22 或更新版本。按回车关闭。'
  read
  exit 1
fi
if [[ ! -d node_modules/tsx || ! -d node_modules/ws ]]; then
  npm install || { print '依赖安装失败。按回车关闭。'; read; exit 1; }
fi
npm start -- "$@"
if [[ $? -ne 0 ]]; then
  print '启动失败，请查看上方错误。按回车关闭。'
  read
  exit 1
fi
