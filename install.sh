#!/bin/bash
set -e

DISPATCHER_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.lark-dispatcher"
PLUGIN_DIR="$DISPATCHER_DIR/plugin"

echo "=== Lark Dispatcher Install ==="

# 1. Create config directory
mkdir -p "$CONFIG_DIR/logs"

# 2. Create default config if not exists
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
  echo "✅ Created default config: $CONFIG_DIR/config.json"
  echo "   ⚠️  Edit it with your Lark app credentials!"
else
  echo "✅ Config exists: $CONFIG_DIR/config.json"
fi

# 3. Install daemon dependencies
echo "Installing daemon dependencies..."
cd "$DISPATCHER_DIR" && bun install --no-summary

# 4. Ensure plugin is registered as local-channels marketplace
PLUGINS_DIR="$HOME/.claude/plugins"
MARKETPLACE_DIR="$PLUGINS_DIR/marketplaces/local-channels"
CACHE_DIR="$PLUGINS_DIR/cache/local-channels/lark-customized/0.0.1"

mkdir -p "$MARKETPLACE_DIR/external_plugins"
mkdir -p "$(dirname "$CACHE_DIR")"

# Symlink plugin source
ln -sfn "$PLUGIN_DIR" "$MARKETPLACE_DIR/external_plugins/lark-customized"
ln -sfn "$PLUGIN_DIR" "$CACHE_DIR"

# marketplace.json
cat > "$MARKETPLACE_DIR/marketplace.json" << 'MKT'
{
  "plugins": [
    {
      "name": "lark-customized",
      "description": "Lark channel for Claude Code (dispatcher mode)",
      "version": "0.0.1",
      "type": "external_plugin"
    }
  ]
}
MKT

# known_marketplaces.json — add local-channels if not present
KNOWN="$PLUGINS_DIR/known_marketplaces.json"
if [ -f "$KNOWN" ]; then
  if ! grep -q "local-channels" "$KNOWN" 2>/dev/null; then
    # Add local-channels entry
    bun -e "
      const fs = require('fs');
      const known = JSON.parse(fs.readFileSync('$KNOWN','utf8'));
      known['local-channels'] = { type: 'local', path: '$MARKETPLACE_DIR' };
      fs.writeFileSync('$KNOWN', JSON.stringify(known, null, 2));
    " 2>/dev/null || true
  fi
fi

# installed_plugins.json — add entry
INSTALLED="$PLUGINS_DIR/installed_plugins.json"
if [ -f "$INSTALLED" ]; then
  bun -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$INSTALLED','utf8'));
    if (!data['lark-customized@local-channels']) {
      data['lark-customized@local-channels'] = [{
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

echo "✅ Plugin registered: lark-customized@local-channels"

# 5. Install plugin dependencies
echo "Installing plugin dependencies..."
cd "$PLUGIN_DIR" && bun install --no-summary 2>/dev/null || true

echo ""
echo "=== Install Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit config:  vim $CONFIG_DIR/config.json"
echo "  2. Start daemon:  cd $DISPATCHER_DIR && bun run src/index.ts start"
echo "  3. Check status:  cd $DISPATCHER_DIR && bun run src/index.ts status"
