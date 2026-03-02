import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {createDb, createLicense, findActiveLicense, findLicenseByPaymentId} from '../src/db.js'

describe('Database', () => {
  let db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('should create a monthly license', () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)

    const result = createLicense(db, {
      loginUsername: 'testuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_test_123',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    expect(result.lastInsertRowid).toBeTruthy()

    const license = findActiveLicense(db, 'testuser', 'key-123')
    expect(license).toBeTruthy()
    expect(license.login_username).toBe('testuser')
    expect(license.app_key).toBe('key-123')
    expect(license.product_type).toBe('monthly')
    expect(license.active).toBe(1)
  })

  it('should create a lifetime license', () => {
    const expires = new Date()
    expires.setFullYear(expires.getFullYear() + 100)

    createLicense(db, {
      loginUsername: 'lifetimeuser',
      appKey: 'key-lt',
      stripePaymentId: 'pi_lifetime_1',
      productType: 'lifetime',
      expiresAt: expires.toISOString(),
    })

    const license = findActiveLicense(db, 'lifetimeuser', 'key-lt')
    expect(license).toBeTruthy()
    expect(license.product_type).toBe('lifetime')
  })

  it('should not find expired licenses', () => {
    const expired = new Date()
    expired.setDate(expired.getDate() - 1)

    createLicense(db, {
      loginUsername: 'expireduser',
      appKey: 'key-exp',
      stripePaymentId: 'pi_expired_1',
      productType: 'monthly',
      expiresAt: expired.toISOString(),
    })

    const license = findActiveLicense(db, 'expireduser', 'key-exp')
    expect(license).toBeUndefined()
  })

  it('should find license by payment ID (idempotency)', () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)

    createLicense(db, {
      loginUsername: 'testuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_unique_123',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const found = findLicenseByPaymentId(db, 'pi_unique_123')
    expect(found).toBeTruthy()
    expect(found.login_username).toBe('testuser')

    const notFound = findLicenseByPaymentId(db, 'pi_doesnt_exist')
    expect(notFound).toBeUndefined()
  })

  it('should require both loginUsername and appKey to match', () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)

    createLicense(db, {
      loginUsername: 'myuser',
      appKey: 'my-app-key',
      stripePaymentId: 'pi_appkey_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    // Exact match
    const exact = findActiveLicense(db, 'myuser', 'my-app-key')
    expect(exact).toBeTruthy()

    // Wrong appKey — should NOT match
    const wrongKey = findActiveLicense(db, 'myuser', 'different-key')
    expect(wrongKey).toBeUndefined()

    // Wrong username — should NOT match
    const wrongUser = findActiveLicense(db, 'otheruser', 'my-app-key')
    expect(wrongUser).toBeUndefined()

    // Missing appKey — should NOT match
    const noKey = findActiveLicense(db, 'myuser', null)
    expect(noKey).toBeUndefined()

    // Missing username — should NOT match
    const noUser = findActiveLicense(db, null, 'my-app-key')
    expect(noUser).toBeUndefined()
  })

  it('should prevent duplicate stripe payment IDs', () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)

    createLicense(db, {
      loginUsername: 'testuser',
      appKey: 'key-123',
      stripePaymentId: 'pi_dup_test',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    expect(() => {
      createLicense(db, {
        loginUsername: 'testuser',
        appKey: 'key-123',
        stripePaymentId: 'pi_dup_test',
        productType: 'monthly',
        expiresAt: expires.toISOString(),
      })
    }).toThrow()
  })

  it('should store email as consultation field', () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)

    createLicense(db, {
      loginUsername: 'myuser',
      appKey: 'key-123',
      email: 'user@example.com',
      stripePaymentId: 'pi_email_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const license = findActiveLicense(db, 'myuser', 'key-123')
    expect(license.email).toBe('user@example.com')
  })
})
