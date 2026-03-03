import {Router} from 'express'
import {findActiveLicense, upsertDevice, logVerification} from '../db.js'
import {createToken, verifyToken} from '../middleware/auth.js'

// Minimum app version required (semver-style comparison)
const MIN_APP_VERSION = '0.1.130'

/**
 * Creates the verify/heartbeat router.
 * @param {import('better-sqlite3').Database} db
 */
export function createVerifyRouter(db) {
  const router = Router()

  /**
   * POST /api/verify
   * Called on login. Validates that the user has an active license.
   *
   * Body: { loginUsername, appKey, deviceFingerprint, appVersion }
   * Returns: { verified, jwt?, expiresIn?, message? }
   */
  router.post('/verify', (req, res) => {
    try {
      const {loginUsername, appKey, deviceFingerprint, appVersion} = req.body
      const ip = req.ip || req.connection?.remoteAddress

      if (!loginUsername || !appKey) {
        logVerification(db, {
          action: 'verify_rejected',
          ip,
          details: `Missing ${!loginUsername ? 'loginUsername' : 'appKey'}`,
        })
        return res.status(400).json({verified: false, message: 'Both Login Username and App Key are required'})
      }

      // Version check
      if (appVersion && !isVersionAllowed(appVersion)) {
        logVerification(db, {
          action: 'verify_rejected',
          ip,
          deviceFingerprint,
          details: `Version ${appVersion} is below minimum ${MIN_APP_VERSION}`,
        })
        return res.status(403).json({
          verified: false,
          message: `This version (${appVersion}) is no longer supported. Please update to continue.`,
        })
      }

      // Find active license by loginUsername + appKey
      const license = findActiveLicense(db, loginUsername.toLowerCase().trim(), appKey.trim())

      if (!license) {
        logVerification(db, {
          action: 'verify_no_license',
          ip,
          deviceFingerprint,
          details: `No active license for ${loginUsername} with appKey ${appKey}`,
        })
        return res.status(403).json({
          verified: false,
          message: 'No active license found for this account. Please purchase access at on the link below',
        })
      }

      // Check if license is expired
      if (new Date(license.expires_at) < new Date()) {
        logVerification(db, {
          licenseId: license.id,
          action: 'verify_expired',
          ip,
          deviceFingerprint,
          details: `License expired at ${license.expires_at}`,
        })
        return res.status(403).json({
          verified: false,
          message: 'Your license has expired. Please renew at personal-software.com',
        })
      }

      // Track device
      if (deviceFingerprint) {
        upsertDevice(db, license.id, deviceFingerprint)
      }

      // Create JWT — store both loginUsername and appKey
      const token = createToken({
        loginUsername: license.login_username,
        appKey: license.app_key,
        licenseId: license.id,
        deviceFingerprint,
      })

      logVerification(db, {
        licenseId: license.id,
        action: 'verify_success',
        ip,
        deviceFingerprint,
      })

      return res.json({
        verified: true,
        jwt: token,
        expiresIn: 1800, // 30 minutes in seconds
        productType: license.product_type,
        expiresAt: license.expires_at,
      })
    } catch (err) {
      console.error('[verify] Error:', err)
      return res.status(500).json({verified: false, message: 'Internal server error'})
    }
  })

  /**
   * POST /api/heartbeat
   * Called periodically to verify the session is still valid.
   *
   * Body: { jwt, deviceFingerprint }
   * Returns: { valid, reason?, newJwt? }
   */
  router.post('/heartbeat', (req, res) => {
    try {
      const {jwt: token, deviceFingerprint} = req.body
      const ip = req.ip || req.connection?.remoteAddress

      if (!token) {
        return res.status(400).json({valid: false, reason: 'Missing token'})
      }

      // Verify the JWT
      let decoded
      try {
        decoded = verifyToken(token)
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          logVerification(db, {action: 'heartbeat_expired', ip, deviceFingerprint})
          return res.status(401).json({valid: false, reason: 'Token expired — re-verification required'})
        }
        logVerification(db, {action: 'heartbeat_invalid', ip, deviceFingerprint})
        return res.status(401).json({valid: false, reason: 'Invalid token'})
      }

      // Re-check the license is still active using loginUsername + appKey from the JWT
      const license = findActiveLicense(db, decoded.loginUsername, decoded.appKey)

      if (!license || new Date(license.expires_at) < new Date()) {
        logVerification(db, {
          licenseId: decoded.licenseId,
          action: 'heartbeat_revoked',
          ip,
          deviceFingerprint,
          details: license ? 'License expired' : 'License not found or deactivated',
        })
        return res.status(403).json({valid: false, reason: 'License no longer valid'})
      }

      // Update device last seen
      if (deviceFingerprint) {
        upsertDevice(db, license.id, deviceFingerprint)
      }

      // Issue a fresh JWT (token rotation)
      const newToken = createToken({
        loginUsername: license.login_username,
        appKey: license.app_key,
        licenseId: license.id,
        deviceFingerprint,
      })

      logVerification(db, {
        licenseId: license.id,
        action: 'heartbeat_ok',
        ip,
        deviceFingerprint,
      })

      return res.json({
        valid: true,
        newJwt: newToken,
        expiresIn: 1800,
      })
    } catch (err) {
      console.error('[heartbeat] Error:', err)
      return res.status(500).json({valid: false, reason: 'Internal server error'})
    }
  })

  return router
}

/**
 * Simple semver comparison: returns true if version >= minVersion.
 */
function isVersionAllowed(version) {
  try {
    const parse = v => v.split('.').map(Number)
    const [aMaj, aMin, aPatch] = parse(version)
    const [bMaj, bMin, bPatch] = parse(MIN_APP_VERSION)
    if (aMaj !== bMaj) return aMaj > bMaj
    if (aMin !== bMin) return aMin > bMin
    return aPatch >= bPatch
  } catch {
    return true // If we can't parse, allow it
  }
}
