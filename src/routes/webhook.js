import {Router} from 'express'
import Stripe from 'stripe'
import {createLicense, findLicenseByPaymentId, revokeAndCarryOver, logVerification} from '../db.js'
import {createInvoiceXpress} from '../services/invoicexpress.js'
import {notifyNewLicensePurchased} from '../services/telegram.js'
import {countries} from '../services/countries.js'
/**
 * Creates the Stripe webhook router.
 * @param {import('better-sqlite3').Database} db
 */
export function createWebhookRouter(db) {
  const router = Router()

  // Stripe sends raw body, we parse it ourselves for signature verification
  router.post('/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature']
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    if (!webhookSecret) {
      console.error('[webhook] STRIPE_WEBHOOK_SECRET not configured')
      return res.status(500).json({error: 'Webhook secret not configured'})
    }

    let event
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
    } catch (err) {
      console.error(`[webhook] Signature verification failed: ${err.message}`)
      return res.status(400).json({error: `Webhook signature verification failed`})
    }

    // We handle two event types:
    // 1. checkout.session.completed — instant card payments
    // 2. payment_intent.succeeded — SEPA / delayed payments (funds confirmed)
    const handledTypes = ['checkout.session.completed', 'payment_intent.succeeded']

    if (!handledTypes.includes(event.type)) {
      // Acknowledge but ignore other event types
      return res.json({received: true, handled: false})
    }

    try {
      const result = await handlePaymentEvent(db, event)
      return res.json({received: true, handled: true, ...result})
    } catch (err) {
      console.error(`[webhook] Error handling ${event.type}: ${err.message}`)
      return res.status(500).json({error: 'Internal error processing webhook'})
    }
  })

  return router
}

/**
 * Process a Stripe payment event and create a license if applicable.
 */
async function handlePaymentEvent(db, event) {
  const PRODUCT_IDS = (process.env.STRIPE_PRODUCT_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)

  let email, customerId, paymentId, priceId, metadata
  let quantity = 1
  let appKey = null
  let loginUsername = null
  let fixedDays = null

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    email = session.customer_details?.email || session.customer_email
    customerId = session.customer
    paymentId = session.payment_intent || session.id
    metadata = session.metadata || {}

    // For SEPA/bank transfers, the payment may not be complete yet
    // Only process if payment_status is 'paid'
    if (session.payment_status !== 'paid') {
      logVerification(db, {
        action: 'webhook_deferred',
        details: `Payment not yet confirmed (status: ${session.payment_status}). Will process on payment_intent.succeeded.`,
      })
      return {deferred: true, reason: 'Payment not yet confirmed'}
    }

    // ── Extract custom fields (App Key, Login Username) ──
    // Payment links with custom fields populate session.custom_fields[]
    // Each has: { key, label, type, text: { value } }
    const customFields = session.custom_fields || []
    for (const field of customFields) {
      const key = (field.key || field.label?.custom || '').toLowerCase()
      const value = field.text?.value || field.dropdown?.value || ''
      if (key.includes('app') && key.includes('key')) {
        appKey = value.trim()
      } else if (key.includes('login') || key.includes('username')) {
        loginUsername = value.trim()
      }
    }

    // ── Get price ID from line items ──
    // checkout.session.completed does NOT include line_items by default
    // We need to expand them via the Stripe API
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      const sessionWithItems = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items'],
      })
      const firstItem = sessionWithItems.line_items?.data?.[0]
      if (firstItem?.price?.id) {
        priceId = firstItem.price.id
      }
      if (firstItem?.quantity && firstItem.quantity > 0) {
        quantity = firstItem.quantity
      }
    } catch (err) {
      console.error(`[webhook] Failed to fetch line items: ${err.message}`)
      // Fall back to metadata
    }

    // Fall back to metadata-based price ID
    if (!priceId) {
      priceId = metadata.price_id || extractPriceIdFromSession(session)
    }
  } else if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object
    email = intent.receipt_email || intent.metadata?.email
    customerId = intent.customer
    paymentId = intent.id
    metadata = intent.metadata || {}
    priceId = metadata.price_id
    appKey = metadata.app_key || null
    loginUsername = metadata.login_username || null
    if (metadata.quantity && Number(metadata.quantity) > 0) {
      quantity = Number(metadata.quantity)
    }
  }

  // Fetch price directly to extract complete metadata (including dynamic days) and product mapping
  let priceMetadata = {}
  let priceProductId = null
  if (priceId) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      const priceObj = await stripe.prices.retrieve(priceId)
      priceProductId = priceObj.product
      priceMetadata = priceObj.metadata || {}
      if (priceMetadata.days) {
        fixedDays = parseInt(priceMetadata.days, 10)
      }
    } catch (err) {
      console.error(`[webhook] Failed to retrieve price ${priceId}: ${err.message}`)
    }
  }

  // Merge price metadata so resolveProductType can detect properties like `plan`
  const combinedMetadata = { ...priceMetadata, ...metadata }

  // Use loginUsername + appKey as primary identity
  // Email is stored separately for consultation only
  const normalizedUsername = (loginUsername || '').toLowerCase().trim()
  const normalizedAppKey = (appKey || '').trim()

  // Determine product type from product ID or combined metadata
  const productType = resolveProductType(priceProductId, combinedMetadata, PRODUCT_IDS)

  if (!productType) {
    // Not a personal-software product — ignore
    logVerification(db, {
      action: 'webhook_ignored',
      details: `Product ID ${priceProductId} does not match allowed products (${PRODUCT_IDS.join(', ')})`,
    })
    return {ignored: true, reason: 'Not a matching product'}
  }

  if (!normalizedUsername || !normalizedAppKey) {
    logVerification(db, {
      action: 'webhook_error',
      details: `Missing required fields — loginUsername: "${loginUsername || ''}", appKey: "${appKey || ''}"`,
    })
    return {error: true, reason: 'Login Username and App Key are both required in payment custom fields'}
  }

  // Idempotency check — don't process the same payment twice
  const existing = findLicenseByPaymentId(db, paymentId)
  if (existing) {
    logVerification(db, {
      licenseId: existing.id,
      action: 'webhook_duplicate',
      details: `Payment ${paymentId} already processed`,
    })
    return {duplicate: true}
  }

  // ── Carry-over logic: revoke old licenses + add remaining days ──
  const {revokedCount, carryOverDays} = revokeAndCarryOver(db, normalizedUsername, normalizedAppKey)
  if (revokedCount > 0) {
    logVerification(db, {
      action: 'license_carryover',
      details: `Revoked ${revokedCount} old license(s) for ${normalizedUsername}, carrying over ${carryOverDays} day(s)`,
    })
  }

  // Calculate expiry with carry-over (lifetime doesn't carry over — already infinite)
  const baseDays = productType === 'lifetime' ? 0 : carryOverDays
  const expiresAt = calculateExpiry(productType, baseDays, quantity, fixedDays)

  // Create license — loginUsername + appKey are the identity, email is just for consultation
  const result = createLicense(db, {
    loginUsername: normalizedUsername,
    appKey: normalizedAppKey,
    email: email || null,
    stripeCustomerId: customerId,
    stripePaymentId: paymentId,
    productType,
    expiresAt,
  })

  logVerification(db, {
    licenseId: result.lastInsertRowid,
    action: 'license_created',
    details: `Product: ${productType}, qty: ${quantity}, loginUsername: ${normalizedUsername}, appKey: ${normalizedAppKey}${baseDays > 0 ? `, +${baseDays}d carry-over` : ''}, expires: ${expiresAt}`,
  })

  console.log(
    `[webhook] ✅ License created for ${normalizedUsername} (appKey: ${normalizedAppKey}) — ${productType} x${quantity}${baseDays > 0 ? ` (+${baseDays}d carry-over)` : ''} (expires ${expiresAt})`,
  )

  // ── Call Invoicexpress and Telegram ──
  const amountObj = event.data.object
  const taxAmountCents = amountObj.total_details?.amount_tax || 0

  const totalAmountCents = amountObj.amount_total || amountObj.amount || 0
  const totalAmountDec = totalAmountCents / 100

  // InvoiceXpress expects the base amount before VAT
  let baseAmountCents = amountObj.amount_subtotal
  if (baseAmountCents === undefined) {
    baseAmountCents = totalAmountCents - taxAmountCents
  }
  const baseAmountDec = baseAmountCents / 100

  const currencyStr = (amountObj.currency || 'eur').toUpperCase()
  const customerCountry = amountObj.customer_details?.address?.country || null
  const countryFullName = countries.find(c => c.code2 === customerCountry)?.name

  const getTaxConfig = () => {
    // If Stripe didn't charge tax, we use the M99 exemption code
    if (!taxAmountCents) {
      return {taxExemptionCode: 'M99'}
    }

    // If tax was charged, we pass the correct InvoiceXpress Tax Name based on the country
    if (customerCountry === 'PT') {
      return {taxName: 'IVA23'}
    }

    if (customerCountry === 'GR') {
      return {taxName: 'EL'}
    }

    if (customerCountry) {
      return {taxName: customerCountry}
    }

    return {}
  }

  let invoice = null
  try {
    const isLifetime = productType === 'lifetime'
    invoice = await createInvoiceXpress({
      itemName: `Personal Software ${isLifetime ? 'Lifetime' : 'Monthly'} License`,
      itemDescription: `License for user ${normalizedUsername}`,
      clientReference: customerId,
      clientEmail: email || '',
      clientName: normalizedUsername,
      amount: baseAmountDec,
      sendByEmail: true,
      currencyCode: currencyStr,
      country: countryFullName,
      ...getTaxConfig(),
    })
  } catch (e) {
    console.error(`[webhook] Invoicexpress integration error:`, e)
  }

  try {
    const licenseEmoji = productType === 'lifetime' ? '🎰 🤑' : '🎉 💰'
    await notifyNewLicensePurchased({
      licenseName: `${licenseEmoji} Personal Software ${productType === 'lifetime' ? 'Lifetime' : 'Monthly'} ${licenseEmoji}`,
      price: totalAmountDec.toFixed(2),
      currency: currencyStr,
      invoice: invoice,
      payment: true,
      customer: {email: email, country: customerCountry},
      endDate: productType === 'lifetime' ? undefined : expiresAt.split('T')[0],
    })
  } catch (e) {
    console.error(`[webhook] Telegram integration error:`, e)
  }

  return {created: true, licenseId: result.lastInsertRowid, carryOverDays: baseDays}
}

/**
 * Try to extract price ID from checkout session line items.
 * Line items might be in session.line_items or need to be extracted from metadata.
 */
function extractPriceIdFromSession(session) {
  // Check session metadata first
  if (session.metadata?.price_id) return session.metadata.price_id

  // Line items may be expanded in the session
  if (session.line_items?.data?.[0]?.price?.id) {
    return session.line_items.data[0].price.id
  }

  return null
}

/**
 * Resolve product type from productId or metadata.
 * Returns 'monthly' (which stands for temporary variable duration) | 'lifetime' | null
 */
export function resolveProductType(productId, metadata, targetProductIds = []) {
  const allowedProducts = Array.isArray(targetProductIds) ? targetProductIds : [targetProductIds]

  // Primary: Check if Product ID explicitly matches one of the allowed Product IDs
  if (productId && allowedProducts.includes(productId)) {
    return metadata?.plan === 'lifetime' ? 'lifetime' : 'monthly'
  }

  // Fallback: Check by metadata (if manually set on the payment link or session)
  if (metadata?.product === 'personal-software') {
    return metadata?.plan === 'lifetime' ? 'lifetime' : 'monthly'
  }

  // Explicit external duration pricing as fallback
  if (metadata?.days && !metadata?.product && !productId) return 'monthly'

  return null
}

/**
 * Calculate license expiry date.
 * @param {string} productType — 'monthly' or 'lifetime'
 * @param {number} [extraDays=0] — additional days to add (carry-over from old license)
 * @param {number} [quantity=1] — number of months purchased (multiplies the 30-day base)
 * @param {number|null} [fixedDays=null] — explicit external days for multi-duration packages
 */
export function calculateExpiry(productType, extraDays = 0, quantity = 1, fixedDays = null) {
  const now = new Date()
  if (productType === 'lifetime') {
    // 100 years — effectively permanent
    now.setFullYear(now.getFullYear() + 100)
  } else {
    // temporary duration — base days × quantity + carry-over
    const baseDays = fixedDays !== null ? fixedDays : 30
    const totalDays = baseDays * quantity + extraDays
    now.setDate(now.getDate() + totalDays)
  }
  return now.toISOString()
}
