import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AppConfig } from './types.js'

const CONFIG_DIR = join(homedir(), '.feishu-dispatcher')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export { CONFIG_DIR }

export function loadConfig(): AppConfig {
  const raw = readFileSync(CONFIG_FILE, 'utf8')
  const parsed = JSON.parse(raw) as Partial<AppConfig>

  if (!parsed.feishu?.appId || !parsed.feishu?.appSecret) {
    throw new Error(`config.json: feishu.appId and feishu.appSecret required`)
  }

  return {
    feishu: {
      appId: parsed.feishu.appId,
      appSecret: parsed.feishu.appSecret,
      domain: parsed.feishu.domain ?? 'feishu',
      access: {
        dmPolicy: parsed.feishu.access?.dmPolicy ?? 'pairing',
        allowFrom: parsed.feishu.access?.allowFrom ?? [],
        groups: parsed.feishu.access?.groups ?? {},
        groupAutoReply: parsed.feishu.access?.groupAutoReply ?? [],
      },
    },
    pool: {
      maxWorkers: parsed.pool?.maxWorkers ?? 3,
      basePort: parsed.pool?.basePort ?? 7100,
      daemonApiPort: parsed.pool?.daemonApiPort ?? 8900,
    },
    claude: {
      bin: parsed.claude?.bin ?? 'claude',
      pluginChannel: parsed.claude?.pluginChannel ?? 'plugin:feishu-customized@local-channels',
      systemPrompt: parsed.claude?.systemPrompt,
    },
    log: {
      level: parsed.log?.level ?? 'info',
      dir: parsed.log?.dir ?? join(CONFIG_DIR, 'logs'),
    },
  }
}
