# ERR_CGROUPV2_NOT_MOUNTED

## What the user sees

Generic system banner: "Server in reduced mode" via the `DegradationModeBanner` showing yellow.

## What the system did automatically

`MetricsCollector` detected `/sys/fs/cgroup` is not mounted as cgroup-v2. AdmissionService falls back to `/proc/meminfo`-only mode (per-cgroup attribution unavailable). DegradationController stays in yellow until the mount is restored.

## What an operator should check

```sh
mount | grep cgroup2
stat -fc '%T' /sys/fs/cgroup
```

`cgroup2fs` is the expected output. If you see `tmpfs` or anything else, the host is on cgroup-v1 (Hetzner ARM 22.04 base should not be) or a wrapper container is broken.

Fix:

```sh
sudo systemctl set-default multi-user.target
sudo grub-mkconfig -o /boot/grub/grub.cfg  # ensure systemd.unified_cgroup_hierarchy=1
sudo reboot
```

This requires reboot. On a single-tenant VPS the user will see ~30 s of unavailability.

## Validating chaos scenario

Unit test `metrics-collector.service.test.ts > does not throw if cgroup files vanish mid-run` covers the in-flight failure; the at-boot-mount-missing path is manual.

## Past incidents

None yet.
