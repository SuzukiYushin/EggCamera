#!/bin/zsh
# iPhone(カメラ)と Mac mini の熱状態を1行で出力し、~/Library/Logs/eggcamera-thermal.log に追記する。
#  ・iPhone: idevicediagnostics(USB・アプリ改変不要)でバッテリ温度(SoC近傍の代理指標)を取得。
#            iOSは高温(thermalState serious/critical)で写真を48MP→12MPに制限するため、撮影解像度劣化の先行指標。
#  ・Mac   : pmset -g therm の熱警告(sudo不要)。CPUダイ実温度は powermetrics(sudo)が要るため既定では取らない
#            （取得したい場合は sudoers に NOPASSWD: /usr/bin/powermetrics を足す）。
# 使い方: ./thermal-probe.sh        # 1回測定して出力＋ログ追記
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
IUDID="${IPHONE_UDID:-00008150-00184D192299401C}"
LOG="$HOME/Library/Logs/eggcamera-thermal.log"

# iPhone バッテリ温度(℃) — AppleSmartBattery の Temperature(1/100℃)
itemp=$(idevicediagnostics -u "$IUDID" ioregentry AppleSmartBattery 2>/dev/null | python3 -c "
import sys,plistlib
try: d=plistlib.loads(sys.stdin.buffer.read())
except Exception: print(''); sys.exit()
def find(d,key):
    if isinstance(d,dict):
        for k,v in d.items():
            if k==key and isinstance(v,(int,float)): return v
            r=find(v,key)
            if r is not None: return r
    elif isinstance(d,list):
        for v in d:
            r=find(v,key)
            if r is not None: return r
    return None
t=find(d,'Temperature')
print(f'{t/100:.1f}' if isinstance(t,(int,float)) else '')
" 2>/dev/null)

# Mac 熱警告(あれば WARN)
warn=$(pmset -g therm 2>/dev/null | grep -i "thermal warning level" | grep -vi "No thermal" | head -1 | tr -s ' ')
mac_state="OK"; [ -n "$warn" ] && mac_state="WARN($warn)"
load=$(uptime | sed -E 's/.*load averages?: //' | awk '{print $1}' | tr -d ',')

# 撮影解像度の直近値(劣化と温度の相関を残す)
res=$(grep "Capture saved" "$HOME/EggCamera/data/logs/swift/app.log" 2>/dev/null | tail -1 | grep -oE '[0-9]{4}x[0-9]{4}' | head -1)

line="$(date '+%F %T') iPhone_temp=${itemp:-NA}C mac_therm=$mac_state load=${load:-NA} last_capture=${res:-NA}"
echo "$line"
echo "$line" >> "$LOG"
