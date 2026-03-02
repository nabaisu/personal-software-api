#!/usr/bin/env node

/**
 * Traderline License Admin CLI
 *
 * Interactive terminal UI to manage users and licenses.
 * Run via SSH on the server: node src/admin.js
 */

import Database from 'better-sqlite3'
import readline from 'readline'
import {mkdirSync} from 'fs'
import {dirname} from 'path'
import dotenv from 'dotenv'

dotenv.config()

const DB_PATH = process.env.DB_PATH || './data/personal-software.db'

// Ensure directory exists
if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), {recursive: true})
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

const ask = q => new Promise(resolve => rl.question(q, resolve))

// ── Formatting helpers ──

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const MAGENTA = '\x1b[35m'
const WHITE = '\x1b[37m'
const BG_BLUE = '\x1b[44m'

function clear() {
  process.stdout.write('\x1b[2J\x1b[H')
}

function header(title) {
  const line = '─'.repeat(60)
  console.log(`\n${CYAN}${line}${RESET}`)
  console.log(`${BOLD}${BG_BLUE}${WHITE}  ${title.padEnd(58)}${RESET}`)
  console.log(`${CYAN}${line}${RESET}\n`)
}

function statusBadge(active, expired) {
  if (!active) return `${RED}● REVOKED${RESET}`
  if (expired) return `${YELLOW}● EXPIRED${RESET}`
  return `${GREEN}● ACTIVE${RESET}`
}

function formatDate(isoStr) {
  if (!isoStr) return 'N/A'
  const d = new Date(isoStr)
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'})
}

function daysLeft(expiresAt) {
  if (!expiresAt) return 'N/A'
  const diff = new Date(expiresAt) - new Date()
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24))
  if (days > 36500) return '∞ (lifetime)'
  if (days < 0) return `${RED}expired ${Math.abs(days)}d ago${RESET}`
  return `${days}d`
}

function padCol(str, width) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '')
  const pad = Math.max(0, width - stripped.length)
  return str + ' '.repeat(pad)
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) => {
    const maxContent = rows.reduce((max, row) => {
      const stripped = String(row[i] || '').replace(/\x1b\[[0-9;]*m/g, '')
      return Math.max(max, stripped.length)
    }, 0)
    return Math.max(h.length, maxContent) + 2
  })

  // Header
  const headerLine = headers.map((h, i) => padCol(`${BOLD}${h}${RESET}`, widths[i])).join('│')
  const separator = widths.map(w => '─'.repeat(w)).join('┼')
  console.log(`  ${headerLine}`)
  console.log(`  ${DIM}${separator}${RESET}`)

  // Rows
  for (const row of rows) {
    const line = row.map((cell, i) => padCol(String(cell || ''), widths[i])).join('│')
    console.log(`  ${line}`)
  }

  if (rows.length === 0) {
    console.log(`  ${DIM}(no records)${RESET}`)
  }
  console.log()
}

// ── Database queries ──

function getAllLicenses() {
  return db
    .prepare(
      `
    SELECT l.*, 
      (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) as device_count,
      (SELECT d.last_seen FROM devices d WHERE d.license_id = l.id ORDER BY d.last_seen DESC LIMIT 1) as last_device_seen
    FROM licenses l
    ORDER BY l.created_at DESC
  `,
    )
    .all()
}

function searchLicenses(query) {
  return db
    .prepare(
      `
    SELECT l.*,
      (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) as device_count
    FROM licenses l
    WHERE l.login_username LIKE ? OR l.app_key LIKE ? OR l.stripe_customer_id LIKE ?
    ORDER BY l.created_at DESC
  `,
    )
    .all(`%${query}%`, `%${query}%`, `%${query}%`)
}

function getLicenseById(id) {
  return db.prepare('SELECT * FROM licenses WHERE id = ?').get(id)
}

function getDevicesForLicense(licenseId) {
  return db.prepare('SELECT * FROM devices WHERE license_id = ? ORDER BY last_seen DESC').all(licenseId)
}

function getRecentLogs(limit = 20) {
  return db.prepare('SELECT * FROM verification_logs ORDER BY created_at DESC LIMIT ?').all(limit)
}

// ── Screens ──

async function mainMenu() {
  clear()
  header('Traderline License Admin')

  const licenses = getAllLicenses()
  const active = licenses.filter(l => l.active && new Date(l.expires_at) > new Date()).length
  const expired = licenses.filter(l => l.active && new Date(l.expires_at) <= new Date()).length
  const revoked = licenses.filter(l => !l.active).length

  console.log(
    `  ${GREEN}${active}${RESET} active  │  ${YELLOW}${expired}${RESET} expired  │  ${RED}${revoked}${RESET} revoked  │  ${BOLD}${licenses.length}${RESET} total\n`,
  )

  console.log(`  ${BOLD}1${RESET}  List all licenses`)
  console.log(`  ${BOLD}2${RESET}  Search user`)
  console.log(`  ${BOLD}3${RESET}  Grant new license`)
  console.log(`  ${BOLD}4${RESET}  Revoke a license`)
  console.log(`  ${BOLD}5${RESET}  Reactivate a license`)
  console.log(`  ${BOLD}6${RESET}  Extend a license`)
  console.log(`  ${BOLD}7${RESET}  View license details`)
  console.log(`  ${BOLD}8${RESET}  Recent verification logs`)
  console.log(`  ${BOLD}q${RESET}  Quit`)
  console.log()

  const choice = await ask(`  ${CYAN}▸${RESET} Choose: `)

  switch (choice.trim()) {
    case '1':
      return listLicenses()
    case '2':
      return searchScreen()
    case '3':
      return grantLicense()
    case '4':
      return revokeLicense()
    case '5':
      return reactivateLicense()
    case '6':
      return extendLicense()
    case '7':
      return viewLicenseDetails()
    case '8':
      return viewLogs()
    case 'q':
    case 'Q':
      return quit()
    default:
      return mainMenu()
  }
}

async function listLicenses() {
  clear()
  header('All Licenses')

  const licenses = getAllLicenses()
  const rows = licenses.map(l => {
    const isExpired = new Date(l.expires_at) <= new Date()
    return [
      `${DIM}${l.id}${RESET}`,
      l.login_username,
      l.app_key,
      l.product_type,
      statusBadge(l.active, isExpired),
      daysLeft(l.expires_at),
      formatDate(l.created_at),
      l.device_count || 0,
    ]
  })

  printTable(['ID', 'Username', 'App Key', 'Plan', 'Status', 'Expires', 'Created', 'Devices'], rows)

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function searchScreen() {
  clear()
  header('Search Users')

  const query = await ask(`  ${CYAN}▸${RESET} Search (username, app key, or stripe ID): `)
  if (!query.trim()) return mainMenu()

  const results = searchLicenses(query.trim())
  const rows = results.map(l => {
    const isExpired = new Date(l.expires_at) <= new Date()
    return [
      `${DIM}${l.id}${RESET}`,
      l.login_username,
      l.app_key,
      l.product_type,
      statusBadge(l.active, isExpired),
      daysLeft(l.expires_at),
    ]
  })

  console.log(`\n  Found ${BOLD}${results.length}${RESET} result(s):\n`)
  printTable(['ID', 'Username', 'App Key', 'Plan', 'Status', 'Expires'], rows)

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function grantLicense() {
  clear()
  header('Grant New License')

  const loginUsername = await ask(`  ${CYAN}▸${RESET} Login Username: `)
  if (!loginUsername.trim()) return mainMenu()

  const appKey = await ask(`  ${CYAN}▸${RESET} App Key: `)
  if (!appKey.trim()) {
    console.log(`  ${RED}App Key is required.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  const email = await ask(`  ${CYAN}▸${RESET} Email (optional, for reference): `)

  console.log(`\n  ${BOLD}1${RESET}  Monthly (30 days)`)
  console.log(`  ${BOLD}2${RESET}  Lifetime`)
  console.log(`  ${BOLD}3${RESET}  Custom days\n`)

  const planChoice = await ask(`  ${CYAN}▸${RESET} Plan: `)

  let productType, expiresAt
  const now = new Date()

  switch (planChoice.trim()) {
    case '1':
      productType = 'monthly'
      now.setDate(now.getDate() + 30)
      expiresAt = now.toISOString()
      break
    case '2':
      productType = 'lifetime'
      now.setFullYear(now.getFullYear() + 100)
      expiresAt = now.toISOString()
      break
    case '3':
      const days = await ask(`  ${CYAN}▸${RESET} Number of days: `)
      const d = parseInt(days)
      if (isNaN(d) || d <= 0) {
        console.log(`  ${RED}Invalid number${RESET}`)
        await ask(`  ${DIM}Press Enter...${RESET}`)
        return mainMenu()
      }
      productType = 'monthly'
      now.setDate(now.getDate() + d)
      expiresAt = now.toISOString()
      break
    default:
      return mainMenu()
  }

  console.log(`\n  ${BOLD}Summary:${RESET}`)
  console.log(`    Username: ${loginUsername.trim()}`)
  console.log(`    App Key:  ${appKey.trim()}`)
  console.log(`    Email:    ${email.trim() || 'N/A'}`)
  console.log(`    Plan:     ${productType}`)
  console.log(`    Expires: ${formatDate(expiresAt)} (${daysLeft(expiresAt)})`)

  const confirm = await ask(`\n  ${YELLOW}▸${RESET} Confirm? (y/n): `)
  if (confirm.trim().toLowerCase() !== 'y') return mainMenu()

  try {
    const result = db
      .prepare(
        `
      INSERT INTO licenses (login_username, app_key, email, product_type, expires_at, stripe_payment_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        loginUsername.trim().toLowerCase(),
        appKey.trim(),
        email.trim() || null,
        productType,
        expiresAt,
        `manual_${Date.now()}`,
      )

    console.log(`\n  ${GREEN}✅ License #${result.lastInsertRowid} created successfully!${RESET}`)
  } catch (err) {
    console.log(`\n  ${RED}❌ Error: ${err.message}${RESET}`)
  }

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function revokeLicense() {
  clear()
  header('Revoke License')

  const licenses = getAllLicenses().filter(l => l.active)
  if (licenses.length === 0) {
    console.log(`  ${DIM}No active licenses to revoke.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  const rows = licenses.map(l => [
    `${DIM}${l.id}${RESET}`,
    l.login_username,
    l.app_key,
    l.product_type,
    daysLeft(l.expires_at),
  ])
  printTable(['ID', 'Username', 'App Key', 'Plan', 'Expires'], rows)

  const idStr = await ask(`  ${CYAN}▸${RESET} License ID to revoke (or blank to cancel): `)
  if (!idStr.trim()) return mainMenu()

  const id = parseInt(idStr)
  const license = getLicenseById(id)
  if (!license) {
    console.log(`  ${RED}License not found.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  console.log(`\n  About to revoke: ${BOLD}${license.login_username}${RESET} (${license.product_type})`)
  const confirm = await ask(`  ${RED}▸${RESET} Are you sure? (y/n): `)
  if (confirm.trim().toLowerCase() !== 'y') return mainMenu()

  db.prepare('UPDATE licenses SET active = 0 WHERE id = ?').run(id)
  console.log(`\n  ${GREEN}✅ License #${id} revoked.${RESET}`)
  console.log(`  ${DIM}The user will be locked out on next heartbeat (~10 min).${RESET}`)

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function reactivateLicense() {
  clear()
  header('Reactivate License')

  const licenses = getAllLicenses().filter(l => !l.active)
  if (licenses.length === 0) {
    console.log(`  ${DIM}No revoked licenses to reactivate.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  const rows = licenses.map(l => [
    `${DIM}${l.id}${RESET}`,
    l.login_username,
    l.app_key,
    l.product_type,
    daysLeft(l.expires_at),
  ])
  printTable(['ID', 'Username', 'App Key', 'Plan', 'Expires'], rows)

  const idStr = await ask(`  ${CYAN}▸${RESET} License ID to reactivate (or blank to cancel): `)
  if (!idStr.trim()) return mainMenu()

  const id = parseInt(idStr)
  const license = getLicenseById(id)
  if (!license) {
    console.log(`  ${RED}License not found.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  db.prepare('UPDATE licenses SET active = 1 WHERE id = ?').run(id)
  console.log(`\n  ${GREEN}✅ License #${id} reactivated.${RESET}`)

  // If expired, offer to extend
  if (new Date(license.expires_at) <= new Date()) {
    const extend = await ask(`  ${YELLOW}▸${RESET} License is expired. Extend by 30 days? (y/n): `)
    if (extend.trim().toLowerCase() === 'y') {
      const newExpiry = new Date()
      newExpiry.setDate(newExpiry.getDate() + 30)
      db.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').run(newExpiry.toISOString(), id)
      console.log(`  ${GREEN}✅ Extended to ${formatDate(newExpiry.toISOString())}${RESET}`)
    }
  }

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function extendLicense() {
  clear()
  header('Extend License')

  const licenses = getAllLicenses().filter(l => l.active)
  const rows = licenses.map(l => [
    `${DIM}${l.id}${RESET}`,
    l.login_username,
    l.app_key,
    l.product_type,
    daysLeft(l.expires_at),
    formatDate(l.expires_at),
  ])
  printTable(['ID', 'Username', 'App Key', 'Plan', 'Days Left', 'Current Expiry'], rows)

  const idStr = await ask(`  ${CYAN}▸${RESET} License ID to extend (or blank to cancel): `)
  if (!idStr.trim()) return mainMenu()

  const id = parseInt(idStr)
  const license = getLicenseById(id)
  if (!license) {
    console.log(`  ${RED}License not found.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  console.log(`\n  ${BOLD}1${RESET}  Add 30 days`)
  console.log(`  ${BOLD}2${RESET}  Add 90 days`)
  console.log(`  ${BOLD}3${RESET}  Add 365 days`)
  console.log(`  ${BOLD}4${RESET}  Make lifetime`)
  console.log(`  ${BOLD}5${RESET}  Custom days\n`)

  const choice = await ask(`  ${CYAN}▸${RESET} Choose: `)

  let newExpiry = new Date(Math.max(new Date(license.expires_at), new Date()))
  let newType = license.product_type

  switch (choice.trim()) {
    case '1':
      newExpiry.setDate(newExpiry.getDate() + 30)
      break
    case '2':
      newExpiry.setDate(newExpiry.getDate() + 90)
      break
    case '3':
      newExpiry.setDate(newExpiry.getDate() + 365)
      break
    case '4':
      newExpiry.setFullYear(newExpiry.getFullYear() + 100)
      newType = 'lifetime'
      break
    case '5':
      const days = await ask(`  ${CYAN}▸${RESET} Days to add: `)
      const d = parseInt(days)
      if (isNaN(d) || d <= 0) {
        console.log(`  ${RED}Invalid number${RESET}`)
        await ask(`  ${DIM}Press Enter...${RESET}`)
        return mainMenu()
      }
      newExpiry.setDate(newExpiry.getDate() + d)
      break
    default:
      return mainMenu()
  }

  db.prepare('UPDATE licenses SET expires_at = ?, product_type = ? WHERE id = ?').run(
    newExpiry.toISOString(),
    newType,
    id,
  )

  console.log(
    `\n  ${GREEN}✅ License #${id} extended to ${formatDate(newExpiry.toISOString())} (${daysLeft(newExpiry.toISOString())})${RESET}`,
  )

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function viewLicenseDetails() {
  clear()
  header('License Details')

  const idStr = await ask(`  ${CYAN}▸${RESET} License ID: `)
  if (!idStr.trim()) return mainMenu()

  const id = parseInt(idStr)
  const license = getLicenseById(id)
  if (!license) {
    console.log(`  ${RED}License not found.${RESET}`)
    await ask(`  ${DIM}Press Enter...${RESET}`)
    return mainMenu()
  }

  const isExpired = new Date(license.expires_at) <= new Date()

  console.log(`  ${BOLD}License #${license.id}${RESET}`)
  console.log(`  ${'─'.repeat(40)}`)
  console.log(`  Login Username:  ${BOLD}${license.login_username}${RESET}`)
  console.log(`  App Key:         ${BOLD}${license.app_key}${RESET}`)
  console.log(`  Email:           ${license.email || `${DIM}N/A${RESET}`}`)
  console.log(`  Plan:            ${license.product_type}`)
  console.log(`  Status:          ${statusBadge(license.active, isExpired)}`)
  console.log(`  Stripe Customer: ${license.stripe_customer_id || `${DIM}N/A${RESET}`}`)
  console.log(`  Stripe Payment:  ${license.stripe_payment_id || `${DIM}N/A${RESET}`}`)
  console.log(`  Created:         ${formatDate(license.created_at)}`)
  console.log(`  Granted:         ${formatDate(license.granted_at)}`)
  console.log(`  Expires:         ${formatDate(license.expires_at)} (${daysLeft(license.expires_at)})`)

  const devices = getDevicesForLicense(id)
  if (devices.length > 0) {
    console.log(`\n  ${BOLD}Devices (${devices.length}):${RESET}`)
    const devRows = devices.map(d => [
      d.device_fingerprint.substring(0, 16) + '…',
      formatDate(d.last_seen),
      formatDate(d.created_at),
    ])
    printTable(['Fingerprint', 'Last Seen', 'First Seen'], devRows)
  } else {
    console.log(`\n  ${DIM}No devices registered.${RESET}`)
  }

  // Recent logs for this license
  const logs = db
    .prepare('SELECT * FROM verification_logs WHERE license_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(id)

  if (logs.length > 0) {
    console.log(`  ${BOLD}Recent Activity:${RESET}`)
    const logRows = logs.map(l => [`${DIM}${formatDate(l.created_at)}${RESET}`, l.action, l.ip || `${DIM}—${RESET}`])
    printTable(['Date', 'Action', 'IP'], logRows)
  }

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

async function viewLogs() {
  clear()
  header('Recent Verification Logs')

  const logs = getRecentLogs(30)
  const rows = logs.map(l => [
    `${DIM}${formatDate(l.created_at)}${RESET}`,
    l.action,
    l.license_id || `${DIM}—${RESET}`,
    (l.device_fingerprint || '').substring(0, 12) || `${DIM}—${RESET}`,
    l.ip || `${DIM}—${RESET}`,
    (l.details || '').substring(0, 40),
  ])

  printTable(['Date', 'Action', 'LicID', 'Device', 'IP', 'Details'], rows)

  await ask(`  ${DIM}Press Enter to go back...${RESET}`)
  return mainMenu()
}

function quit() {
  console.log(`\n  ${DIM}Goodbye!${RESET}\n`)
  db.close()
  rl.close()
  process.exit(0)
}

// ── Entry point ──
mainMenu().catch(err => {
  console.error('Fatal error:', err)
  db.close()
  process.exit(1)
})
