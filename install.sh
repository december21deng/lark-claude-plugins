#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.lark-dispatcher"

echo "=== Lark Claude Plugins Install ==="
echo ""
echo "Two modes available:"
echo "  1) standalone  — Single terminal, direct Lark WebSocket (simple)"
echo "  2) dispatcher  — Multi-worker daemon with process pool (advanced)"
echo ""

MODE="${1:-}"
if [ -z "$MODE" ]; then
  read -rp "Choose mode [standalone/dispatcher]: " MODE
fi

case "$MODE" in
  standalone|s|1)
    MODE="standalone"
    ;;
  dispatcher|d|2)
    MODE="dispatcher"
    ;;
  both)
    MODE="both"
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Usage: bash install.sh [standalone|dispatcher|both]"
    exit 1
    ;;
esac

# ── Helper: register a plugin in Claude's local-channels marketplace ──
register_plugin() {
  local PLUGIN_NAME="$1"
  local PLUGIN_DIR="$2"

  PLUGINS_DIR="$HOME/.claude/plugins"
  MARKETPLACE_DIR="$PLUGINS_DIR/marketplaces/local-channels"
  CACHE_DIR="$PLUGINS_DIR/cache/local-channels/$PLUGIN_NAME/0.0.1"

  mkdir -p "$MARKETPLACE_DIR/external_plugins"
  mkdir -p "$(dirname "$CACHE_DIR")"

  # Symlink plugin source
  ln -sfn "$PLUGIN_DIR" "$MARKETPLACE_DIR/external_plugins/$PLUGIN_NAME"
  ln -sfn "$PLUGIN_DIR" "$CACHE_DIR"

  # marketplace.json — add plugin if not present
  MKT_FILE="$MARKETPLACE_DIR/marketplace.json"
  if [ -f "$MKT_FILE" ]; then
    # Check if plugin already listed
    if ! grep -q "\"$PLUGIN_NAME\"" "$MKT_FILE" 2>/dev/null; then
      bun -e "
        const fs = require('fs');
        const mkt = JSON.parse(fs.readFileSync('$MKT_FILE','utf8'));
        mkt.plugins = mkt.plugins || [];
        mkt.plugins.push({
          name: '$PLUGIN_NAME',
          description: 'Lark channel for Claude Code',
          version: '0.0.1',
          type: 'external_plugin'
        });
        fs.writeFileSync('$MKT_FILE', JSON.stringify(mkt, null, 2));
      " 2>/dev/null || true
    fi
  else
    cat > "$MKT_FILE" << MKEOF
{
  "plugins": [
    {
      "name": "$PLUGIN_NAME",
      "description": "Lark channel for Claude Code",
      "version": "0.0.1",
      "type": "external_plugin"
    }
  ]
}
MKEOF
  fi

  # known_marketplaces.json
  KNOWN="$PLUGINS_DIR/known_marketplaces.json"
  if [ -f "$KNOWN" ]; then
    if ! grep -q "local-channels" "$KNOWN" 2>/dev/null; then
      bun -e "
        const fs = require('fs');
        const known = JSON.parse(fs.readFileSync('$KNOWN','utf8'));
        known['local-channels'] = { type: 'local', path: '$MARKETPLACE_DIR' };
        fs.writeFileSync('$KNOWN', JSON.stringify(known, null, 2));
      " 2>/dev/null || true
    fi
  fi

  # installed_plugins.json
  INSTALLED="$PLUGINS_DIR/installed_plugins.json"
  if [ -f "$INSTALLED" ]; then
    bun -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$INSTALLED','utf8'));
      if (!data['${PLUGIN_NAME}@local-channels']) {
        data['${PLUGIN_NAME}@local-channels'] = [{
          scope: 'user',
          installPath: '$CACHE_DIR',
          version: '0.0.1',
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        }];
        fs.writeFileSync('$INSTALLED', JSON.stringify(data, null, 2));
      }
    " 2>/dev/null || true
  fi

  echo "  Registered: $PLUGIN_NAME@local-channels"
}

# ── Standalone mode ──
install_standalone() {
  echo ""
  echo "--- Installing Standalone Mode ---"

  PLUGIN_DIR="$REPO_DIR/plugin-standalone"

  # Install plugin dependencies
  echo "Installing plugin dependencies..."
  cd "$PLUGIN_DIR" && bun install --no-summary 2>/dev/null || true

  # Register plugin
  register_plugin "lark-standalone" "$PLUGIN_DIR"

  echo ""
  echo "Standalone setup complete!"
  echo ""
  echo "Next steps:"
  echo "  1. Set credentials:  /lark-standalone:configure <APP_ID> <APP_SECRET>"
  echo "     Or manually:      echo 'LARK_APP_ID=cli_xxx' > ~/.claude/channels/lark/.env"
  echo "                       echo 'LARK_APP_SECRET=xxx' >> ~/.claude/channels/lark/.env"
  echo "  2. Start Claude:     claude --dangerously-load-development-channels plugin:lark-standalone@local-channels"
}

# ── Dispatcher mode ──
install_dispatcher() {
  echo ""
  echo "--- Installing Dispatcher Mode ---"

  PLUGIN_DIR="$REPO_DIR/plugin-dispatcher"
  DISPATCHER_DIR="$REPO_DIR/dispatcher"

  # Create config directory
  mkdir -p "$CONFIG_DIR/logs"

  # Create default config if not exists
  if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cat > "$CONFIG_DIR/config.json" << 'CONF'
{
  "lark": {
    "appId": "YOUR_APP_ID",
    "appSecret": "YOUR_APP_SECRET",
    "domain": "feishu",
    "access": {
      "dmPolicy": "open",
      "allowFrom": [],
      "groups": {},
      "groupAutoReply": []
    }
  },
  "pool": {
    "maxWorkers": 3,
    "basePort": 7100,
    "daemonApiPort": 8900
  },
  "claude": {
    "bin": "claude",
    "pluginChannel": "plugin:lark-customized@local-channels"
  },
  "log": {
    "level": "info",
    "dir": "~/.lark-dispatcher/logs"
  }
}
CONF
    echo "  Created default config: $CONFIG_DIR/config.json"
    echo "  Edit it with your Lark app credentials!"
  else
    echo "  Config exists: $CONFIG_DIR/config.json"
  fi

  # Install daemon dependencies
  echo "Installing daemon dependencies..."
  cd "$DISPATCHER_DIR" && bun install --no-summary

  # Register plugin
  register_plugin "lark-customized" "$PLUGIN_DIR"

  # Install plugin dependencies
  echo "Installing plugin dependencies..."
  cd "$PLUGIN_DIR" && bun install --no-summary 2>/dev/null || true

  echo ""
  echo "Dispatcher setup complete!"
  echo ""
  echo "Next steps:"
  echo "  1. Edit config:      vim $CONFIG_DIR/config.json"
  echo "  2. Start daemon:     cd $DISPATCHER_DIR && bun run src/index.ts start"
  echo "  3. Check status:     cd $DISPATCHER_DIR && bun run src/index.ts status"
}

# ── Execute ──
if [ "$MODE" = "standalone" ] || [ "$MODE" = "both" ]; then
  install_standalone
fi

if [ "$MODE" = "dispatcher" ] || [ "$MODE" = "both" ]; then
  install_dispatcher
fi

echo ""
echo "=== Install Complete ==="
