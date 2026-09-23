#!/bin/bash
# 常驻商人看门狗：60s 一次探活，掉线自动拉起（打补丁时先 pkill -f mule-watchdog）
while true; do
  if ! curl -s -m 5 http://127.0.0.1:8790/status | grep -q '"online":true'; then
    echo "[$(date '+%H:%M:%S')] 商人失联 → 重启"
    pkill -f "node mule.js" 2>/dev/null
    sleep 2
    cd /Users/quyue/www/u-router/ro-analysis && nohup node mule.js >> /tmp/mule-live.log 2>&1 &
    echo "[$(date '+%H:%M:%S')] 已重启 pid $!"
  fi
  sleep 60
done
