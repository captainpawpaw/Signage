#!/usr/bin/env bash
# Builds the Signage OS image for PCs (64-bit: old workstations, thin clients,
# laptops, mini PCs). Debian is built in; nothing is downloaded on the screen.
#
#   sudo os/pc/build.sh [OUTPUT_DIR]        -> OUTPUT_DIR/signage-os-pc.img
#
# Needs: debootstrap, gdisk, dosfstools, e2fsprogs, losetup (util-linux).
set -euo pipefail
export MTOOLS_SKIP_CHECK=1

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mkdir -p "${1:-$HERE/../out}" && cd "${1:-$HERE/../out}" && pwd)
SUITE=${SIGNAGE_DEBIAN_SUITE:-trixie}
MIRROR=${SIGNAGE_DEBIAN_MIRROR:-http://deb.debian.org/debian}
WORK=${SIGNAGE_WORK:-$(mktemp -d)}
ROOTFS="$WORK/rootfs"
IMG="$OUT/signage-os-pc.img"

PACKAGES=(
  # system
  systemd-sysv udev dbus libpam-systemd systemd-timesyncd sudo kbd console-setup console-setup-linux
  linux-image-amd64 initramfs-tools zstd
  grub-pc-bin grub-efi-amd64-signed shim-signed efibootmgr
  gdisk cloud-guest-utils dosfstools e2fsprogs exfatprogs parted util-linux
  # network
  network-manager wpasupplicant avahi-daemon libnss-mdns ca-certificates curl iproute2 iputils-ping
  openssh-server
  # player
  nodejs chromium cage fonts-dejavu-core fonts-noto-color-emoji libgl1-mesa-dri libegl1 libgbm1
  # hardware support
  firmware-linux-free firmware-misc-nonfree firmware-realtek firmware-iwlwifi firmware-atheros
  firmware-brcm80211 firmware-amd-graphics firmware-intel-graphics firmware-intel-sound
  intel-microcode amd64-microcode
  # troubleshooting
  less nano
)

in_root() { chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 "$@"; }
cleanup() {
  for m in dev/pts dev proc sys; do mountpoint -q "$ROOTFS/$m" && umount "$ROOTFS/$m"; done
  [ -n "${LOOP:-}" ] && losetup -d "$LOOP" 2>/dev/null
  return 0
}
trap cleanup EXIT

if [ ! -e "$ROOTFS/.debootstrap-done" ]; then
  echo "== Debian $SUITE base system"
  rm -rf "$ROOTFS"
  debootstrap --variant=minbase --components=main,contrib,non-free-firmware "$SUITE" "$ROOTFS" "$MIRROR"
  touch "$ROOTFS/.debootstrap-done"
fi

for m in dev dev/pts proc sys; do mount --bind "/$m" "$ROOTFS/$m"; done
cat > "$ROOTFS/etc/apt/sources.list" <<EOF
deb $MIRROR $SUITE main contrib non-free-firmware
deb $MIRROR $SUITE-updates main contrib non-free-firmware
deb http://security.debian.org/debian-security $SUITE-security main contrib non-free-firmware
EOF
# Services are not started while building.
printf '#!/bin/sh\nexit 101\n' > "$ROOTFS/usr/sbin/policy-rc.d"
chmod 755 "$ROOTFS/usr/sbin/policy-rc.d"

echo "== Packages"
in_root apt-get update
in_root apt-get install -y --no-install-recommends "${PACKAGES[@]}"
in_root apt-get clean
rm -f "$ROOTFS/usr/sbin/policy-rc.d"
rm -rf "$ROOTFS"/var/lib/apt/lists/*

echo "== Configuration"
echo signage-os > "$ROOTFS/etc/hostname"
cat > "$ROOTFS/etc/hosts" <<'EOF'
127.0.0.1 localhost
127.0.1.1 signage-os
::1       localhost ip6-localhost ip6-loopback
EOF
mkdir -p "$ROOTFS/etc/signage-os"
echo pc > "$ROOTFS/etc/signage-os/platform"
date -u +%Y-%m-%d > "$ROOTFS/etc/signage-os/build"
install -m 755 "$HERE/../common/signage-firstboot" "$ROOTFS/usr/local/sbin/signage-firstboot"
install -m 755 "$HERE/signage-install-disk" "$ROOTFS/usr/local/sbin/signage-install-disk"
install -m 644 "$HERE/../common/signage-firstboot.service" "$ROOTFS/etc/systemd/system/signage-firstboot.service"
"$HERE/../common/configure.sh" "$ROOTFS"
# What people see on the SIGNAGE drive after flashing.
mkdir -p "$ROOTFS/boot/efi"
cp "$HERE/../common/wifi.txt" "$HERE/../common/README.txt" "$ROOTFS/boot/efi/"

echo "== Disk image"
for m in dev/pts dev proc sys; do umount "$ROOTFS/$m"; done
USED_MB=$(du -sxm "$ROOTFS" | cut -f1)
ROOT_MB=$(( (USED_MB * 115 / 100 + 400) / 64 * 64 ))
IMG_MB=$(( ROOT_MB + 1 + 256 + 4 ))
rm -f "$IMG"
truncate -s "${IMG_MB}M" "$IMG"
LOOP=$(losetup --show -fP "$IMG")
"$HERE/signage-install-disk" "$LOOP" "$ROOTFS"
losetup -d "$LOOP"
LOOP=""
echo "== Done: $IMG (${IMG_MB} MB)"
