import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AppConfig } from './types.js'

const CONFIG_DIR = join(homedir(), '.lark-dispatcher')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export { CONFIG_DIR }

export function loadConfig(): AppConfig {
  const raw = readFileSync(CONFIG_FILE, 'utf8')
  const parsed = JSON.parse(raw) as Partial<AppConfig>

  if (!parsed.lark?.appId || !parsed.lark?.appSecret) {
    throw new Error(`config.json: lark.appId and lark.appSecret required`)
  }

  return {
    lark: {
      appId: parsed.lark.appId,
      appSecret: parsed.lark.appSecret,
      domain: parsed.lark.domain ?? 'feishu',
      superadmins: parsed.lark.superadmins ?? [],
      access: {
        dmPolicy: parsed.lark.access?.dmPolicy ?? 'pairing',
        allowFrom: parsed.lark.access?.allowFrom ?? [],
        groups: parsed.lark.access?.groups ?? {},
        groupAutoReply: parsed.lark.access?.groupAutoReply ?? [],
      },
    },
    pool: {
      maxWorkers: parsed.pool?.maxWorkers ?? 3,
      basePort: parsed.pool?.basePort ?? 7100,
      daemonApiPort: parsed.pool?.daemonApiPort ?? 8900,
    },
    claude: {
      bin: parsed.claude?.bin ?? 'claude',
      pluginChannel: parsed.claude?.pluginChannel ?? 'plugin:lark-customized@local-channels',
      systemPrompt: parsed.claude?.systemPrompt,
    },
    log: {
      level: parsed.log?.level ?? 'info',
      dir: parsed.log?.dir ?? join(CONFIG_DIR, 'logs'),
    },
  }
}
