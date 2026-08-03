# A Debian machine for testing install.sh.
#
# systemd runs as PID 1 so the script's service handling is exercised for real:
# `systemctl enable`, unit parsing, and dependency ordering all behave
# differently under a stub. Starting from a bare image also means the script
# has to install everything it claims to, rather than finding it already there.
FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus \
  && rm -rf /var/lib/apt/lists/*

# Units that cannot work in a container and would otherwise fail noisily.
RUN find /etc/systemd/system /lib/systemd/system \
      -path '*.wants/*' \
      \( -name '*getty*' -o -name '*udev*' -o -name '*mount*' -o -name '*swap*' \) \
      -delete

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
