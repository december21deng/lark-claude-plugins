import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

let logDir: string | null = null

export function initLogger(dir: string): void {
  logDir = dir
  mkdirSync(dir, { recursive: true })
}

function logFile(): string {
  const date = new Date().toISOString().slice(0, 10)
  return join(logDir ?? '/tmp', `${date}.log`)
}

function write(level: string, tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] ${level.padEnd(5)} [${tag}] ${msg}\n`
  process.stderr.write(line)
  if (logDir) {
    try { appendFileSync(logFile(), line) } catch {}
  }
}

export const log = {
  info: (tag: string, msg: string) => write('INFO', tag, msg),
  warn: (tag: string, msg: string) => write('WARN', tag, msg),
  error: (tag: string, msg: string) => write('ERROR', tag, msg),
}
