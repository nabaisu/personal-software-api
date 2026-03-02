import Database from 'better-sqlite3'
import {mkdirSync} from 'fs'
import {dirname} from 'path'

/**
 * Initialize and return a SQLite database instance.
 * @param {string} [dbPath] — override path (useful for testing with ':memory:')
 */
export function createDb(dbPath) {
  const resolvedPath = dbPath || process.env.DB_PATH || './data/personal-software.db'

  // Ensure directory exists for file-based DBs
  if (resolvedPath !== ':memory:') {
    mkdirSync(dirname(resolvedPath), {recursive: true})
  }

  const db = new Database(resolvedPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_username TEXT NOT NULL,
      app_key TEXT NOT NULL,
      email TEXT,
      stripe_customer_id TEXT,
      stripe_payment_id TEXT UNIQUE,
      product_type TEXT NOT NULL CHECK(product_type IN ('monthly', 'lifetime')),
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_login_username ON licenses(login_username);
    CREATE INDEX IF NOT EXISTS idx_licenses_app_key ON licenses(app_key);
    CREATE INDEX IF NOT EXISTS idx_licenses_login_appkey ON licenses(login_username, app_key);
    CREATE INDEX IF NOT EXISTS idx_licenses_stripe_payment ON licenses(stripe_payment_id);

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL,
      device_fingerprint TEXT NOT NULL,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (license_id) REFERENCES licenses(id)
    );

    CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);
    CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices(device_fingerprint);

    CREATE TABLE IF NOT EXISTS verification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER,
      device_fingerprint TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  return db
}

// ── License helpers ──

/**
 * Find an active, non-expired license matching BOTH loginUsername AND appKey.
 * Both are required — this is the primary way to identify a user.
 */
export function findActiveLicense(db, loginUsername, appKey) {
  if (!loginUsername || !appKey) return undefined

  return db
    .prepare(
      `
    SELECT * FROM licenses
    WHERE login_username = ? AND app_key = ? AND active = 1 AND datetime(expires_at) > datetime('now')
    ORDER BY granted_at DESC
    LIMIT 1
  `,
    )
    .get(loginUsername, appKey)
}

/**
 * Revoke all active licenses for a loginUsername+appKey and return the total
 * remaining days to carry over to a new license.
 */
export function revokeAndCarryOver(db, loginUsername, appKey) {
  const activeLicenses = db
    .prepare(
      `SELECT * FROM licenses WHERE login_username = ? AND app_key = ? AND active = 1 AND datetime(expires_at) > datetime('now')`,
    )
    .all(loginUsername, appKey)

  let carryOverMs = 0

  for (const lic of activeLicenses) {
    // Calculate remaining time
    const remaining = new Date(lic.expires_at) - new Date()
    if (remaining > 0 && lic.product_type !== 'lifetime') {
      carryOverMs += remaining
    }
    // Revoke the old license
    db.prepare('UPDATE licenses SET active = 0 WHERE id = ?').run(lic.id)
  }

  const carryOverDays = Math.ceil(carryOverMs / (1000 * 60 * 60 * 24))
  return {revokedCount: activeLicenses.length, carryOverDays}
}

/**
 * Create a new license entry.
 */
export function createLicense(
  db,
  {loginUsername, appKey, email, stripeCustomerId, stripePaymentId, productType, expiresAt},
) {
  const stmt = db.prepare(`
    INSERT INTO licenses (login_username, app_key, email, stripe_customer_id, stripe_payment_id, product_type, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  return stmt.run(
    loginUsername,
    appKey,
    email || null,
    stripeCustomerId || null,
    stripePaymentId || null,
    productType,
    expiresAt,
  )
}

/**
 * Check if a stripe payment has already been processed (idempotency).
 */
export function findLicenseByPaymentId(db, stripePaymentId) {
  return db.prepare(`SELECT * FROM licenses WHERE stripe_payment_id = ?`).get(stripePaymentId)
}

// ── Device helpers ──

export function upsertDevice(db, licenseId, deviceFingerprint) {
  const existing = db
    .prepare(`SELECT * FROM devices WHERE license_id = ? AND device_fingerprint = ?`)
    .get(licenseId, deviceFingerprint)

  if (existing) {
    db.prepare(`UPDATE devices SET last_seen = datetime('now') WHERE id = ?`).run(existing.id)
    return existing
  }

  const result = db
    .prepare(`INSERT INTO devices (license_id, device_fingerprint) VALUES (?, ?)`)
    .run(licenseId, deviceFingerprint)
  return {id: result.lastInsertRowid, license_id: licenseId, device_fingerprint: deviceFingerprint}
}

// ── Logging ──

export function logVerification(db, {licenseId, deviceFingerprint, ip, action, details}) {
  db.prepare(
    `INSERT INTO verification_logs (license_id, device_fingerprint, ip, action, details) VALUES (?, ?, ?, ?, ?)`,
  ).run(licenseId || null, deviceFingerprint || null, ip || null, action, details || null)
}
