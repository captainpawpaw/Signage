#!/usr/bin/env bash
# Shared Signage OS settings, applied to the image's root file system.
#   configure.sh ROOTFS
set -euo pipefail
R=$1

# A local account for troubleshooting at the keyboard (Ctrl+Alt+F2):
# admin / signage, which must be changed at the first login.
if ! chroot "$R" id admin >/dev/null 2>&1; then
  chroot "$R" useradd -m -s /bin/bash -G sudo admin
fi
echo 'admin:signage' | chroot "$R" chpasswd
chroot "$R" chage -d 0 admin
chroot "$R" passwd -l root >/dev/null

# The player owns the screen; the first start runs until it is installed.
mkdir -p "$R/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/signage-firstboot.service "$R/etc/systemd/system/multi-user.target.wants/signage-firstboot.service"
ln -sf /dev/null "$R/etc/systemd/system/getty@tty1.service"
ln -sf /lib/systemd/system/multi-user.target "$R/etc/systemd/system/default.target"

# Remote login stays off unless someone turns it on.
for unit in ssh.service ssh.socket sshd.service; do
  rm -f "$R/etc/systemd/system/multi-user.target.wants/$unit" "$R/etc/systemd/system/sockets.target.wants/$unit"
done
rm -f "$R/etc/systemd/system/sshd.service"

# No background downloads; keep the logs small.
for unit in apt-daily.timer apt-daily-upgrade.timer man-db.timer; do ln -sf /dev/null "$R/etc/systemd/system/$unit"; done
mkdir -p "$R/etc/systemd/journald.conf.d"
printf '[Journal]\nSystemMaxUse=64M\n' > "$R/etc/systemd/journald.conf.d/signage.conf"

# Never sleep (laptops: also with the lid closed).
mkdir -p "$R/etc/systemd/logind.conf.d"
cat > "$R/etc/systemd/logind.conf.d/signage.conf" <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
EOF
for unit in sleep.target suspend.target hibernate.target hybrid-sleep.target; do ln -sf /dev/null "$R/etc/systemd/system/$unit"; done

# Find the server by name (signage.local).
if [ -f "$R/etc/nsswitch.conf" ] && ! grep -q mdns "$R/etc/nsswitch.conf"; then
  sed -i 's/^hosts:.*/hosts:          files mdns4_minimal [NOTFOUND=return] dns/' "$R/etc/nsswitch.conf"
fi

# NetworkManager looks after every network connection.
mkdir -p "$R/etc/NetworkManager/conf.d"
printf '[ifupdown]\nmanaged=true\n' > "$R/etc/NetworkManager/conf.d/signage.conf"

# Each device gets its own name on first start: signage-<last 6 of its MAC>.
cat > "$R/usr/local/sbin/signage-hostname" <<'EOF'
#!/bin/sh
[ "$(cat /etc/hostname)" = signage-os ] || exit 0
mac=$(cat /sys/class/net/*/address 2>/dev/null | grep -v '^00:00:00' | head -1 | tr -d ':')
[ -n "$mac" ] || exit 0
name="signage-$(echo "$mac" | tail -c 7)"
echo "$name" > /etc/hostname
sed -i "s/signage-os/$name/" /etc/hosts
hostname "$name"
EOF
chmod 755 "$R/usr/local/sbin/signage-hostname"
cat > "$R/etc/systemd/system/signage-hostname.service" <<'EOF'
[Unit]
Description=Signage OS device name
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target NetworkManager.service avahi-daemon.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/signage-hostname

[Install]
WantedBy=sysinit.target
EOF
mkdir -p "$R/etc/systemd/system/sysinit.target.wants"
ln -sf /etc/systemd/system/signage-hostname.service "$R/etc/systemd/system/sysinit.target.wants/signage-hostname.service"

echo 'LANG=C.UTF-8' > "$R/etc/default/locale"
