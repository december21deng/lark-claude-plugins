#!/usr/bin/env bun
/**
 * IM Dispatcher — entry point.
 *
 * Usage:
 *   bun run src/index.ts start          # foreground
 *   bun run src/index.ts start --daemon # background (TODO)
 *   bun run src/index.ts stop
 *   bun run src/index.ts status
 */

import { loadConfig, CONFIG_DIR } from './config.js'
import { initLogger, log } from './utils/logger.js'
import { startDaemon } from './daemon.js'
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'

const PID_FILE = join(CONFIG_DIR, 'daemon.pid')
const command = process.argv[2] ?? 'start'

mkdirSync(CONFIG_DIR, { recursive: true })

switch (command) {
  case 'start': {
    // Load config
    if (!existsSync(join(CONFIG_DIR, 'config.json'))) {
      console.error(`Config not found: ${join(CONFIG_DIR, 'config.json')}`)
      console.error('Run install.sh first or create config manually.')
      process.exit(1)
    }

    const config = loadConfig()
    initLogger(config.log.dir)

    // Write PID
    writeFileSync(PID_FILE, String(process.pid))

    log.info('main', `Starting daemon (pid=${process.pid})`)
    await startDaemon(config)
    break
  }

  case 'stop': {
    if (!existsSync(PID_FILE)) {
      console.log('Daemon not running (no PID file)')
      process.exit(0)
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    try {
      process.kill(pid, 'SIGTERM')
      console.log(`Sent SIGTERM to daemon (pid=${pid})`)
    } catch (e) {
      console.log(`Daemon not running (pid=${pid}): ${e}`)
    }
    try { unlinkSync(PID_FILE) } catch {}
    break
  }

  case 'status': {
    if (!existsSync(PID_FILE)) {
      console.log('Daemon: not running')
      process.exit(0)
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    try {
      process.kill(pid, 0) // Check if process exists
      console.log(`Daemon: running (pid=${pid})`)
      // Try to hit health endpoint
      try {
        const config = loadConfig()
        const res = await fetch(`http://localhost:${config.pool.daemonApiPort}/health`)
        const data = await res.json() as any
        console.log(`API: :${config.pool.daemonApiPort} (workers=${data.workers})`)
      } catch {
        console.log('API: not responding')
      }
    } catch {
      console.log(`Daemon: not running (stale PID ${pid})`)
      try { unlinkSync(PID_FILE) } catch {}
    }
    break
  }

  default:
    console.error(`Unknown command: ${command}`)
    console.error('Usage: bun run src/index.ts [start|stop|status]')
    process.exit(1)
}
