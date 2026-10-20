#!/usr/bin/env bash
# Builds the Signage OS image for Raspberry Pi (3, 4, 5, 400, 500, Zero 2 W)
# from the official Raspberry Pi OS Lite (64-bit) image: adds Node.js,
# Chromium, cage and the Signage first start, so nothing is downloaded on the
# screen. Raspberry Pi Imager's settings (Wi-Fi, user, SSH) keep working.
#
#   sudo os/pi/build.sh RASPIOS_LITE_ARM64.img [OUTPUT_DIR]   -> OUTPUT_DIR/signage-os-pi.img
#
# Needs: parted, e2fsprogs, mtools, qemu-user-static with binfmt_misc for
# aarch64 (when building on a PC).
set -euo pipefail
export MTOOLS_SKIP_CHECK=1

HERE=$(cd "$(dirname "$0")" && pwd)
BASE_IMG=$1
OUT=$(mkdir -p "${2:-$HERE/../out}" && cd "${2:-$HERE/../out}" && pwd)
IMG="$OUT/signage-os-pi.img"
EXTRA_MB=${SIGNAGE_PI_EXTRA_MB:-1536}
MNT=$(mktemp -d)
PACKAGES=(nodejs chromium cage fonts-dejavu-core fonts-noto-color-emoji)

in_root() { chroot "$MNT" /usr/bin/env DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 "$@"; }
cleanup() {
  for m in dev/pts dev proc sys ""; do mountpoint -q "$MNT/$m" && umount "$MNT/$m"; done
  [ -n "${LOOP:-}" ] && losetup -d "$LOOP" 2>/dev/null
  rmdir "$MNT" 2>/dev/null
  return 0
}
trap cleanup EXIT

echo "== Copying $BASE_IMG"
cp --sparse=always "$BASE_IMG" "$IMG"
truncate -s "+${EXTRA_MB}M" "$IMG"
parted -s "$IMG" resizepart 2 100%

LOOP=$(losetup --show -fP "$IMG")
for _ in $(seq 20); do
  [ -b "${LOOP}p2" ] && break
  partx -u "$LOOP" 2>/dev/null || partx -a "$LOOP" 2>/dev/null || true
  sleep 0.5
done
e2fsck -fy "${LOOP}p2" >/dev/null || true
resize2fs "${LOOP}p2"

mount "${LOOP}p2" "$MNT"
for m in dev dev/pts proc sys; do mount --bind "/$m" "$MNT/$m"; done
mv "$MNT/etc/resolv.conf" "$MNT/etc/resolv.conf.signage" 2>/dev/null || true
cp /etc/resolv.conf "$MNT/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"
chmod 755 "$MNT/usr/sbin/policy-rc.d"

echo "== Packages"
in_root apt-get update
in_root apt-get install -y --no-install-recommends "${PACKAGES[@]}"
in_root apt-get clean
rm -rf "$MNT"/var/lib/apt/lists/*
rm -f "$MNT/usr/sbin/policy-rc.d" "$MNT/etc/resolv.conf"
mv "$MNT/etc/resolv.conf.signage" "$MNT/etc/resolv.conf" 2>/dev/null || true

echo "== Configuration"
mkdir -p "$MNT/etc/signage-os"
echo pi > "$MNT/etc/signage-os/platform"
date -u +%Y-%m-%d > "$MNT/etc/signage-os/build"
echo signage-os > "$MNT/etc/hostname"
sed -i 's/raspberrypi/signage-os/g' "$MNT/etc/hosts"
install -m 755 "$HERE/../common/signage-firstboot" "$MNT/usr/local/sbin/signage-firstboot"
install -m 644 "$HERE/../common/signage-firstboot.service" "$MNT/etc/systemd/system/signage-firstboot.service"
"$HERE/../common/configure.sh" "$MNT"
# The "create a user" dialog would take over the screen: Signage OS has its
# own troubleshooting account, and Imager can still add one.
rm -f "$MNT/etc/systemd/system/multi-user.target.wants/userconfig.service"
ln -sf /dev/null "$MNT/etc/systemd/system/userconfig.service"

umount "$MNT/dev/pts" "$MNT/dev" "$MNT/proc" "$MNT/sys"
umount "$MNT"

echo "== Boot partition"
CMDLINE=$(mktemp)
mtype -i "${LOOP}p1" ::cmdline.txt | tr -d '\r\n' > "$CMDLINE"
grep -q consoleblank=0 "$CMDLINE" || sed -i '1 s/$/ consoleblank=0 fbcon=font:TER16x32/' "$CMDLINE"
echo >> "$CMDLINE"
mcopy -o -i "${LOOP}p1" "$CMDLINE" ::cmdline.txt
mcopy -o -i "${LOOP}p1" "$HERE/../common/README.txt" "$HERE/../common/wifi.txt" ::
mlabel -i "${LOOP}p1" ::SIGNAGE
rm -f "$CMDLINE"

losetup -d "$LOOP"
LOOP=""
echo "== Done: $IMG"
