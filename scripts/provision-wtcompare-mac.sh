#!/bin/bash
set -euo pipefail

if ! id _wtcompare >/dev/null 2>&1; then
  dscl . -create /Users/_wtcompare
  dscl . -create /Users/_wtcompare UserShell /usr/bin/false
  dscl . -create /Users/_wtcompare RealName "WebTransport Compare"
  UIDN=499
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$UIDN"; do
    UIDN=$((UIDN - 1))
  done
  dscl . -create /Users/_wtcompare UniqueID "$UIDN"
  dscl . -create /Users/_wtcompare PrimaryGroupID 20
  dscl . -create /Users/_wtcompare NFSHomeDirectory /var/db/webtransport-bun
  dscl . -append /Groups/staff GroupMembership _wtcompare || true
fi

install -d -o root -g wheel -m 755 /usr/local/libexec/webtransport-bun/comparison
install -d -o root -g wheel -m 755 /var/db/webtransport-bun
install -d -o _wtcompare -g staff -m 700 /var/db/webtransport-bun/comparison
install -d -o _wtcompare -g staff -m 700 /var/db/webtransport-bun/comparison/keys

printf '%s\n' '_wtcompare ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/wtcompare
chmod 440 /etc/sudoers.d/wtcompare

ADMIN_USER=$(stat -f %Su /dev/console)
cat >/etc/sudoers.d/wtcompare-admin <<EOF
${ADMIN_USER} ALL=(_wtcompare) NOPASSWD: ALL
${ADMIN_USER} ALL=(root) NOPASSWD: /usr/bin/install, /bin/mkdir, /usr/sbin/chown, /bin/chmod, /usr/bin/dscl, /bin/ln, /usr/bin/sudo
EOF
chmod 440 /etc/sudoers.d/wtcompare-admin
visudo -cf /etc/sudoers.d/wtcompare
visudo -cf /etc/sudoers.d/wtcompare-admin
id _wtcompare
ls -la /var/db/webtransport-bun/comparison/keys
echo PROVISION_OK
