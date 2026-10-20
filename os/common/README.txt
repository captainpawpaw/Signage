Signage OS
==========

1. Copy the setup file from your Signage console onto this drive:
   Screens > Add a screen > Raspberry Pi / Linux > signage-linux-setup.sh
   (If the server runs on the same network and is called signage.local,
   the screen finds it by itself and this step can be skipped.)

2. Wi-Fi only: fill in wifi.txt on this drive. Ethernet needs nothing.

3. Start the screen from this drive. It installs the player and shows a
   pairing code: enter it in the console under Screens > Pair a screen.

PCs started from a USB stick offer to install Signage OS on the internal
disk, so the stick is not needed afterwards.

Keyboard troubleshooting: Ctrl+Alt+F2, user "admin", password "signage"
(you are asked to choose a new password at the first login).
