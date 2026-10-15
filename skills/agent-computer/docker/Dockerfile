# agent-computer desktop image: a Linux desktop (XFCE) with a browser, Blender and office apps,
# viewable over noVNC and controllable with xdotool. Agents can also run inside it.
FROM node:22-trixie

ARG DEBIAN_FRONTEND=noninteractive
ARG INSTALL_AGENTS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini sudo ca-certificates curl git jq ripgrep unzip procps less nano socat \
      python3 python3-pip python3-venv \
      xvfb x11-utils x11vnc novnc python3-websockify xdotool wmctrl xclip scrot imagemagick \
      dbus-x11 at-spi2-core xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal thunar \
      adwaita-icon-theme fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu \
      mesa-utils libgl1-mesa-dri \
      chromium gimp \
      libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libxkbcommon-x11-0 libsm6 libice6 \
      libgl1 libegl1 libglu1-mesa libvulkan1 libwayland-client0 libwayland-cursor0 libwayland-egl1 libdecor-0-0 \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \
    && rm -rf /var/lib/apt/lists/*

# Official Blender build: Debian's package lacks OpenImageDenoise, which Cycles uses by default.
ARG BLENDER_VERSION=5.2.2
RUN series="${BLENDER_VERSION%.*}" \
    && curl -fsSL "https://download.blender.org/release/Blender${series}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
       | tar -xJ -C /opt \
    && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender

# Reuse the image's uid-1000 user so files in a bind-mounted /workspace keep the host owner.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
    && usermod -aG video,audio agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && mkdir -p /workspace && chown agent:agent /workspace

# Agent CLIs for `agent-computer run`, plus Playwright's MCP server for browser automation.
RUN if [ "$INSTALL_AGENTS" = "1" ]; then \
      npm install -g --no-fund --no-audit \
        @anthropic-ai/claude-code \
        @openai/codex \
        @agentclientprotocol/claude-agent-acp@0.91.0 \
        @agentclientprotocol/codex-acp@2.2.2 \
        @playwright/mcp \
      && npm cache clean --force; \
    fi

COPY --chmod=755 entrypoint.sh /usr/local/bin/ac-desktop
COPY --chmod=755 ac-browser.sh /usr/local/bin/ac-browser
COPY computer-guide.md /etc/agent-computer/AGENTS.md

USER agent
WORKDIR /home/agent

# Cursor's CLI only ships as a remote install script, so it is opt-in (AGENT_COMPUTER_WITH_CURSOR=1).
ARG INSTALL_CURSOR=0
RUN if [ "$INSTALL_CURSOR" = "1" ]; then curl -fsS https://cursor.com/install | bash; fi \
    # Skip XFCE's first-run panel dialog.
    && mkdir -p ~/.config/xfce4/xfconf/xfce-perchannel-xml \
    && cp /etc/xdg/xfce4/panel/default.xml ~/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
    && mkdir -p ~/.claude ~/.codex \
    && cp /etc/agent-computer/AGENTS.md ~/.claude/CLAUDE.md \
    && cp /etc/agent-computer/AGENTS.md ~/.codex/AGENTS.md

ENV DISPLAY=:1 \
    PATH=/home/agent/.local/bin:$PATH \
    AC_RESOLUTION=1280x800

EXPOSE 6080 9223
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ac-desktop"]
