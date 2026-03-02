import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {resolveProductType, calculateExpiry} from '../src/routes/webhook.js'
import {createDb, createLicense, revokeAndCarryOver, findActiveLicense} from '../src/db.js'

describe('Webhook helpers', () => {
  const priceIds = {
    MONTHLY_PRICE_ID: 'price_monthly_123',
    LIFETIME_PRICE_ID: 'price_lifetime_456',
  }

  describe('resolveProductType', () => {
    it('should resolve monthly product by price ID', () => {
      expect(resolveProductType('price_monthly_123', {}, priceIds)).toBe('monthly')
    })

    it('should resolve lifetime product by price ID', () => {
      expect(resolveProductType('price_lifetime_456', {}, priceIds)).toBe('lifetime')
    })

    it('should resolve by metadata when price ID does not match', () => {
      const metadata = {product: 'personal-software', plan: 'monthly'}
      expect(resolveProductType('price_other', metadata, priceIds)).toBe('monthly')
    })

    it('should resolve lifetime by metadata', () => {
      const metadata = {product: 'personal-software', plan: 'lifetime'}
      expect(resolveProductType('price_other', metadata, priceIds)).toBe('lifetime')
    })

    it('should return null for non-personal-software products', () => {
      expect(resolveProductType('price_other', {}, priceIds)).toBeNull()
    })

    it('should return null for personal-software metadata with unknown plan', () => {
      const metadata = {product: 'personal-software', plan: 'yearly'}
      expect(resolveProductType('price_other', metadata, priceIds)).toBeNull()
    })

    it('should return null for completely unrelated metadata', () => {
      const metadata = {product: 'some-other-app', plan: 'monthly'}
      expect(resolveProductType('price_other', metadata, priceIds)).toBeNull()
    })
  })

  describe('calculateExpiry', () => {
    it('should set monthly expiry to ~30 days from now', () => {
      const expiry = calculateExpiry('monthly')
      const diff = new Date(expiry) - new Date()
      const days = diff / (1000 * 60 * 60 * 24)
      expect(days).toBeGreaterThan(29)
      expect(days).toBeLessThan(31)
    })

    it('should set lifetime expiry to ~100 years from now', () => {
      const expiry = calculateExpiry('lifetime')
      const diff = new Date(expiry) - new Date()
      const years = diff / (1000 * 60 * 60 * 24 * 365)
      expect(years).toBeGreaterThan(99)
      expect(years).toBeLessThan(101)
    })

    it('should add carry-over days to monthly expiry', () => {
      const expiry = calculateExpiry('monthly', 15)
      const diff = new Date(expiry) - new Date()
      const days = diff / (1000 * 60 * 60 * 24)
      expect(days).toBeGreaterThan(44) // 30 + 15 = 45, minus tiny rounding
      expect(days).toBeLessThan(46)
    })

    it('should ignore carry-over for lifetime (handled by caller)', () => {
      const expiry = calculateExpiry('lifetime', 0)
      const diff = new Date(expiry) - new Date()
      const years = diff / (1000 * 60 * 60 * 24 * 365)
      expect(years).toBeGreaterThan(99)
    })

    it('should multiply 30 days by quantity 2 (60 days)', () => {
      const expiry = calculateExpiry('monthly', 0, 2)
      const diff = new Date(expiry) - new Date()
      const days = diff / (1000 * 60 * 60 * 24)
      expect(days).toBeGreaterThan(59)
      expect(days).toBeLessThan(61)
    })

    it('should multiply 30 days by quantity 3 (90 days)', () => {
      const expiry = calculateExpiry('monthly', 0, 3)
      const diff = new Date(expiry) - new Date()
      const days = diff / (1000 * 60 * 60 * 24)
      expect(days).toBeGreaterThan(89)
      expect(days).toBeLessThan(91)
    })

    it('should combine quantity with carry-over days', () => {
      const expiry = calculateExpiry('monthly', 10, 2)
      const diff = new Date(expiry) - new Date()
      const days = diff / (1000 * 60 * 60 * 24)
      // 30 * 2 + 10 = 70 days
      expect(days).toBeGreaterThan(69)
      expect(days).toBeLessThan(71)
    })

    it('should ignore quantity for lifetime', () => {
      const expiry = calculateExpiry('lifetime', 0, 5)
      const diff = new Date(expiry) - new Date()
      const years = diff / (1000 * 60 * 60 * 24 * 365)
      expect(years).toBeGreaterThan(99)
    })
  })
})

describe('License carry-over', () => {
  let db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('should revoke old license and return remaining days', () => {
    const expires = new Date()
    expires.setDate(expires.getDate() + 20) // 20 days left

    createLicense(db, {
      loginUsername: 'user1',
      appKey: 'key-1',
      stripePaymentId: 'pi_old_1',
      productType: 'monthly',
      expiresAt: expires.toISOString(),
    })

    const {revokedCount, carryOverDays} = revokeAndCarryOver(db, 'user1', 'key-1')
    expect(revokedCount).toBe(1)
    expect(carryOverDays).toBeGreaterThanOrEqual(19) // ~20 days left
    expect(carryOverDays).toBeLessThanOrEqual(21)

    // Old license should be revoked
    const old = findActiveLicense(db, 'user1', 'key-1')
    expect(old).toBeUndefined()
  })

  it('should carry over 0 days if no active licenses exist', () => {
    const {revokedCount, carryOverDays} = revokeAndCarryOver(db, 'nobody', 'key-x')
    expect(revokedCount).toBe(0)
    expect(carryOverDays).toBe(0)
  })

  it('should not carry over days from lifetime licenses', () => {
    const expires = new Date()
    expires.setFullYear(expires.getFullYear() + 100)

    createLicense(db, {
      loginUsername: 'user2',
      appKey: 'key-2',
      stripePaymentId: 'pi_lt_old',
      productType: 'lifetime',
      expiresAt: expires.toISOString(),
    })

    const {revokedCount, carryOverDays} = revokeAndCarryOver(db, 'user2', 'key-2')
    expect(revokedCount).toBe(1)
    expect(carryOverDays).toBe(0) // lifetime doesn't carry over
  })
})
