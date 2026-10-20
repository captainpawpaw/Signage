#!/usr/bin/env bash
# Boots a Signage OS PC image in QEMU against a local Signage server and checks
# the whole first start: the screen finds the setup file, installs the player,
# shows up in the console as a pairing request, gets paired and comes online.
#
#   os/test/boot-test.sh IMAGE [bios|uefi] [disk|install]
#     disk     the image is the computer's disk; the setup file is on a USB stick
#     install  the image is a USB stick (with the setup file on its SIGNAGE
#              drive) and the computer has an empty disk: Signage OS installs
#              itself onto the disk, restarts from it and carries on
#
# Writes screenshots (PPM) next to the image. Needs qemu-system-x86_64,
# qemu-img, mtools, dosfstools, curl, node (and OVMF for uefi).
set -euo pipefail
export MTOOLS_SKIP_CHECK=1

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
IMG=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
FIRMWARE=${2:-bios}
MODE=${3:-disk}
PORT=${SIGNAGE_TEST_PORT:-8080}
TIMEOUT=${SIGNAGE_TEST_TIMEOUT:-1500}
WORK=$(mktemp -d)
SHOTS=$(dirname "$IMG")
BASE="http://127.0.0.1:$PORT"
JAR="$WORK/cookies"
MON="$WORK/monitor.sock"
ACCEL=$([ -w /dev/kvm ] && echo "-enable-kvm -cpu host" || echo "-cpu max")

cleanup() {
  local rc=$?
  if [ "$rc" != 0 ] && [ -f "$WORK/server.log" ]; then echo "--- server log"; tail -40 "$WORK/server.log"; fi
  [ -n "${QEMU_PID:-}" ] && kill "$QEMU_PID" 2>/dev/null
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

monitor() { printf '%s\n' "$*" | timeout 5 socat - "UNIX-CONNECT:$MON" >/dev/null 2>&1 || true; }
shot() { monitor "screendump $SHOTS/boot-test-$FIRMWARE-$MODE-$1.ppm"; echo "screenshot: $SHOTS/boot-test-$FIRMWARE-$MODE-$1.ppm"; }
api() { curl -fsS -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }
elapsed() { echo $(( $(date +%s) - START )); }

echo "== Signage server on port $PORT"
PORT=$PORT HOST=0.0.0.0 DATA_DIR="$WORK/data" ADMIN_PASSWORD=boot-test MDNS=off \
  PUBLIC_URL="http://10.0.2.2:$PORT" node "$REPO/server/index.js" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do curl -fs "$BASE/api/hello" >/dev/null && break; sleep 0.2; done
api -X POST "$BASE/api/login" -d '{"password":"boot-test"}' >/dev/null
curl -fsS "$BASE/addon/signage-linux-setup.sh" -o "$WORK/signage-linux-setup.sh"

echo "== Disks ($FIRMWARE, $MODE)"
DRIVES=()
qemu-img create -q -f qcow2 -b "$IMG" -F raw "$WORK/os.qcow2" 8G
if [ "$MODE" = install ]; then
  # The Signage OS stick with the setup file copied onto its SIGNAGE drive.
  ESP_START=$(sgdisk -i 2 "$IMG" | sed -n 's/^First sector: \([0-9]*\).*/\1/p')
  qemu-img convert -O raw "$WORK/os.qcow2" "$WORK/stick.img"
  mcopy -o -i "$WORK/stick.img@@$((ESP_START * 512))" "$WORK/signage-linux-setup.sh" ::
  qemu-img create -q -f qcow2 "$WORK/internal.qcow2" 16G
  DRIVES+=(-drive "if=none,id=stick,format=raw,file=$WORK/stick.img" -device "usb-storage,bus=xhci.0,drive=stick,removable=on,bootindex=0,id=stickdev")
  DRIVES+=(-drive "if=none,id=internal,format=qcow2,file=$WORK/internal.qcow2" -device "virtio-blk-pci,drive=internal,bootindex=1")
else
  mkfs.vfat -C -n USBSTICK "$WORK/usb.img" 32768 >/dev/null
  mcopy -i "$WORK/usb.img" "$WORK/signage-linux-setup.sh" ::
  DRIVES+=(-drive "if=none,id=os,format=qcow2,file=$WORK/os.qcow2" -device "virtio-blk-pci,drive=os,bootindex=0")
  DRIVES+=(-drive "if=none,id=stick,format=raw,file=$WORK/usb.img" -device "usb-storage,bus=xhci.0,drive=stick")
fi
FW=()
if [ "$FIRMWARE" = uefi ]; then
  for f in /usr/share/ovmf/OVMF.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/qemu/OVMF.fd; do [ -f "$f" ] && FW=(-bios "$f") && break; done
fi

echo "== Booting"
# shellcheck disable=SC2086
qemu-system-x86_64 $ACCEL -m 3072 -smp 2 "${FW[@]}" -device qemu-xhci,id=xhci "${DRIVES[@]}" \
  -nic user,model=virtio-net-pci -vga std -display none -monitor "unix:$MON,server,nowait" \
  -serial "file:$WORK/serial.log" > "$WORK/qemu.log" 2>&1 &
QEMU_PID=$!
START=$(date +%s)

serial() { # waits for a "signage-os: ..." progress line from the first start
  echo "   waiting for: $1"
  until grep -q "signage-os: $1" "$WORK/serial.log" 2>/dev/null; do
    [ "$(elapsed)" -lt "$TIMEOUT" ] || { echo "FAIL: no \"$1\" after $(elapsed)s"; shot fail; tail -c 3000 "$WORK/serial.log"; exit 1; }
    kill -0 "$QEMU_PID" 2>/dev/null || { echo "QEMU exited"; cat "$WORK/qemu.log"; exit 1; }
    sleep 3
  done
}

if [ "$MODE" = install ]; then
  echo "== Install from the stick onto the internal disk"
  serial install-offer
  sleep 3
  shot 1-install-offer
  monitor "sendkey i"; sleep 3
  for key in shift-y shift-e shift-s ret; do monitor "sendkey $key"; sleep 0.5; done
  serial "installing on"
  shot 2-installing
  serial "installed, remove the stick"
  echo "installed after $(elapsed)s"
  shot 3-remove-stick
  monitor "device_del stickdev"
fi
serial "player installed"

echo "== Waiting for the pairing request (up to ${TIMEOUT}s)"
CODE=""
while [ "$(elapsed)" -lt "$TIMEOUT" ]; do
  kill -0 "$QEMU_PID" 2>/dev/null || { echo "QEMU exited"; cat "$WORK/qemu.log"; exit 1; }
  CODE=$(api "$BASE/api/pairings" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);process.stdout.write(p[0]?.code||"")})')
  [ -n "$CODE" ] && break
  sleep 10
done
shot 4-pairing
if [ -z "$CODE" ]; then echo "FAIL: no pairing request after $(elapsed)s"; tail -20 "$WORK/server.log"; exit 1; fi
echo "pairing code $CODE after $(elapsed)s"

api -X POST "$BASE/api/pairings/$CODE" -d '{"name":"QEMU test screen"}' >/dev/null
echo "== Waiting for the screen to come online"
while [ "$(elapsed)" -lt "$TIMEOUT" ]; do
  ONLINE=$(api "$BASE/api/screens" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).some(x=>x.status?.online)))})')
  [ "$ONLINE" = true ] && break
  sleep 5
done
sleep 30
shot 5-player
if [ "$ONLINE" != true ]; then echo "FAIL: screen paired but not online"; exit 1; fi
echo "PASS: paired and online after $(elapsed)s"
