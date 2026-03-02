import jwt from 'jsonwebtoken'

const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me'
const JWT_EXPIRY = '30m'

/**
 * Create a signed JWT for a verified user.
 */
export function createToken({loginUsername, appKey, licenseId, deviceFingerprint}) {
  return jwt.sign({loginUsername, appKey, licenseId, deviceFingerprint}, JWT_SECRET(), {expiresIn: JWT_EXPIRY})
}

/**
 * Verify and decode a JWT. Returns the decoded payload or throws.
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET())
}

/**
 * Express middleware that extracts and verifies the JWT from the Authorization header.
 * Attaches decoded payload to `req.auth`.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({valid: false, reason: 'Missing or invalid authorization header'})
  }

  try {
    const token = authHeader.slice(7)
    req.auth = verifyToken(token)
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({valid: false, reason: 'Token expired'})
    }
    return res.status(401).json({valid: false, reason: 'Invalid token'})
  }
}
