#!/usr/bin/env node

/**
 * SQLite Database Backup
 *
 * Creates timestamped backups of the database using SQLite's backup API.
 * Keeps the last N backups and deletes older ones.
 *
 * Usage:
 *   node src/backup.js              — run once
 *   node src/backup.js --schedule   — run every 6 hours
 */

import Database from 'better-sqlite3'
import {mkdirSync, readdirSync, unlinkSync, statSync} from 'fs'
import {join, dirname} from 'path'
import dotenv from 'dotenv'

dotenv.config()

const DB_PATH = process.env.DB_PATH || './data/personal-software.db'
const BACKUP_DIR = process.env.BACKUP_DIR || './data/backups'
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '30')
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Create a backup of the database.
 * Uses SQLite's .backup() which is safe even while the DB is being written to.
 */
export async function createBackup(dbPath = DB_PATH, backupDir = BACKUP_DIR) {
  mkdirSync(backupDir, {recursive: true})

  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const backupFile = join(backupDir, `personal-software_${timestamp}.db`)

  try {
    const db = new Database(dbPath, {readonly: true})
    await db.backup(backupFile)
    db.close()

    const size = statSync(backupFile).size
    const sizeKB = (size / 1024).toFixed(1)
    console.log(`[backup] ✅ Created: ${backupFile} (${sizeKB} KB)`)

    // Clean old backups
    pruneBackups(backupDir, MAX_BACKUPS)

    return backupFile
  } catch (err) {
    console.error(`[backup] ❌ Failed: ${err.message}`)
    return null
  }
}

/**
 * Delete old backups, keeping only the most recent `maxBackups`.
 */
function pruneBackups(backupDir, maxBackups) {
  try {
    const files = readdirSync(backupDir)
      .filter(f => f.startsWith('personal-software_') && f.endsWith('.db'))
      .sort()
      .reverse() // newest first

    if (files.length > maxBackups) {
      const toDelete = files.slice(maxBackups)
      for (const file of toDelete) {
        unlinkSync(join(backupDir, file))
        console.log(`[backup] 🗑  Pruned old backup: ${file}`)
      }
    }
  } catch (err) {
    console.error(`[backup] Prune error: ${err.message}`)
  }
}

/**
 * Start the backup scheduler (runs on an interval).
 * Also creates an immediate backup on start.
 */
export function startBackupScheduler(dbPath = DB_PATH) {
  console.log(
    `[backup] Scheduler started — backing up every ${BACKUP_INTERVAL_MS / 3600000}h, keeping last ${MAX_BACKUPS}`,
  )

  // Immediate backup
  createBackup(dbPath)

  // Schedule recurring backups
  return setInterval(() => createBackup(dbPath), BACKUP_INTERVAL_MS)
}

// ── CLI entry point ──
const isMainModule = process.argv[1]?.endsWith('backup.js')

if (isMainModule) {
  const isSchedule = process.argv.includes('--schedule')

  if (isSchedule) {
    startBackupScheduler()
    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\n[backup] Scheduler stopped.')
      process.exit(0)
    })
  } else {
    createBackup()
  }
}
