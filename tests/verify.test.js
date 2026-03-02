import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {createApp} from '../src/index.js'
import {createDb, createLicense} from '../src/db.js'

// Tiny test helper — makes HTTP requests to the Express app
async function request(app, method, path, body, headers = {}) {
  const {default: http} = await import('http')
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-app-client': 'PersonalSoftware',
          ...headers,
        },
      }

      const req = http.request(options, res => {
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => {
          server.close()
          try {
            resolve({status: res.statusCode, data: JSON.parse(data)})
          } catch {
            resolve({status: res.statusCode, data})
          }
        })
      })

      req.on('error', err => {
        server.close()
        reject(err)
      })

      if (body) req.write(bodyStr)
      req.end()
    })
  })
}

describe('Verify API', () => {
  let app, db

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-key'
    db = createDb(':memory:')
    app = createApp(db)
  })

  afterEach(() => {
    db.close()
  })

  it('should reject when no loginUsername provided', async () => {
    const res = await request(app, 'POST', '/api/verify', {appKey: 'key'})
    expect(res.status).toBe(400)
    expect(res.data.verified).toBe(false)
  })

  it('should reject when no appKey provided', async () => {
    const res = await request(app, 'POST', '/api/verify', {loginUsername: 'testuser'})
    expect(res.status).toBe(400)
    expect(res.data.verified).toBe(false)
    expect(res.data.message).toContain('App Key')
  })

  it('should reject when no license exists', async () => {
    const res = await request(app, 'POST', '/api/verify', {
      loginUsername: 'nobody',
      appKey: 'key-123',
    })
    expect(res.status).toBe(403)
    expect(res.data.verified).toBe(false)
    expect(res.data.message).toContain('No active license')
  })

  it('should reject expired license', async () => {
    const expired = new Date()
    expired.setDate(expired.getDate() - 1)
    createLicense(db, {
      loginUsername: 'expireduser',
      appKey: 'key-123',
      stripePaymentId: 'pi_exp_1',
      productType: 'monthly',
      expiresAt: expired.toISOString(),
    })

    const res = await request(app, 'POST', '/api/verify', {
      loginUsername: 'expireduser',
      appKey: 'key-123',
    })
    expect(res.status).toBe(403)
    expect(res.data.verified).toBe(false)
  })

  it('should verify active license and return JWT', async () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    createLicense(db, {
      loginUsername: 'activeuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_active_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const res = await request(app, 'POST', '/api/verify', {
      loginUsername: 'activeuser',
      appKey: 'key-123',
      deviceFingerprint: 'fp-abc-123',
    })

    expect(res.status).toBe(200)
    expect(res.data.verified).toBe(true)
    expect(res.data.jwt).toBeTruthy()
    expect(res.data.expiresIn).toBe(1800)
    expect(res.data.productType).toBe('monthly')
  })

  it('should verify with case-insensitive loginUsername', async () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    createLicense(db, {
      loginUsername: 'myuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_case_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const res = await request(app, 'POST', '/api/verify', {
      loginUsername: 'MyUser',
      appKey: 'key-123',
    })

    expect(res.status).toBe(200)
    expect(res.data.verified).toBe(true)
  })

  it('should reject old app version', async () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    createLicense(db, {
      loginUsername: 'myuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_ver_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const res = await request(app, 'POST', '/api/verify', {
      loginUsername: 'myuser',
      appKey: 'key-123',
      appVersion: '0.0.1',
    })

    expect(res.status).toBe(403)
    expect(res.data.verified).toBe(false)
    expect(res.data.message).toContain('no longer supported')
  })

  it('should reject when appKey does not match', async () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    createLicense(db, {
      loginUsername: 'myuser',
      appKey: 'correct-key',
      stripePaymentId: 'pi_wrong_key_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const res = await request(app, 'POST', '/api/verify', {
      loginUsername: 'myuser',
      appKey: 'wrong-key',
    })

    expect(res.status).toBe(403)
    expect(res.data.verified).toBe(false)
  })
})

describe('Heartbeat API', () => {
  let app, db

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-key'
    db = createDb(':memory:')
    app = createApp(db)
  })

  afterEach(() => {
    db.close()
  })

  it('should reject when no token provided', async () => {
    const res = await request(app, 'POST', '/api/heartbeat', {deviceFingerprint: 'fp-123'})
    expect(res.status).toBe(400)
    expect(res.data.valid).toBe(false)
  })

  it('should reject invalid token', async () => {
    const res = await request(app, 'POST', '/api/heartbeat', {
      jwt: 'invalid-token-here',
      deviceFingerprint: 'fp-123',
    })
    expect(res.status).toBe(401)
    expect(res.data.valid).toBe(false)
  })

  it('should accept valid heartbeat and rotate token', async () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    createLicense(db, {
      loginUsername: 'hbuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_hb_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const verifyRes = await request(app, 'POST', '/api/verify', {
      loginUsername: 'hbuser',
      appKey: 'key-123',
      deviceFingerprint: 'fp-hb-123',
    })
    expect(verifyRes.data.verified).toBe(true)

    const hbRes = await request(app, 'POST', '/api/heartbeat', {
      jwt: verifyRes.data.jwt,
      deviceFingerprint: 'fp-hb-123',
    })

    expect(hbRes.status).toBe(200)
    expect(hbRes.data.valid).toBe(true)
    expect(hbRes.data.newJwt).toBeTruthy()
    expect(hbRes.data.newJwt.split('.').length).toBe(3)
  })

  it('should reject heartbeat when license is deactivated', async () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    const result = createLicense(db, {
      loginUsername: 'deactuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_deact_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const verifyRes = await request(app, 'POST', '/api/verify', {
      loginUsername: 'deactuser',
      appKey: 'key-123',
    })
    expect(verifyRes.data.verified).toBe(true)

    db.prepare('UPDATE licenses SET active = 0 WHERE id = ?').run(result.lastInsertRowid)

    const hbRes = await request(app, 'POST', '/api/heartbeat', {
      jwt: verifyRes.data.jwt,
      deviceFingerprint: 'fp-123',
    })

    expect(hbRes.status).toBe(403)
    expect(hbRes.data.valid).toBe(false)
  })
})

describe('Health Check', () => {
  it('should return ok', async () => {
    const db = createDb(':memory:')
    const app = createApp(db)

    const res = await request(app, 'GET', '/health', null)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ok')

    db.close()
  })
})
