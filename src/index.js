import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import {createDb} from './db.js'
import {createWebhookRouter} from './routes/webhook.js'
import {createVerifyRouter} from './routes/verify.js'
import {startBackupScheduler} from './backup.js'

/**
 * Create the Express app. Exported separately for testing.
 * @param {import('better-sqlite3').Database} [db] — optional DB instance (for testing)
 */
export function createApp(db) {
  db = db || createDb()
  const app = express()

  // Trust proxy headers (for Hetzner / nginx reverse proxy)
  app.set('trust proxy', 1)

  // Helmet adds several security-focused HTTP headers
  app.use(helmet())

  // CORS — allow the Tauri app to call us
  app.use(cors())

  // Stripe webhooks need raw body for signature verification
  app.use('/webhook', express.raw({type: 'application/json'}))

  // App-Client Blocker Middleware for the API routes
  const requireAppClient = (req, res, next) => {
    if (req.headers['x-app-client'] !== 'PersonalSoftware') {
      return res.status(403).json({error: 'Forbidden Client'})
    }
    next()
  }

  // Rate Limiting to prevent brute-forcing licenses and DDoS
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window`
    message: {verified: false, valid: false, message: 'Too many requests, please try again later.'},
    standardHeaders: true,
    legacyHeaders: false,
  })

  // All other routes use JSON parsing, client check and rate limit
  app.use('/api', express.json(), requireAppClient, apiLimiter)

  // Request logging (production)
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const duration = Date.now() - start
      if (req.path !== '/health') {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`)
      }
    })
    next()
  })

  // Health check
  app.get('/health', (_req, res) => {
    res.json({status: 'ok', timestamp: new Date().toISOString()})
  })

  // Routes
  app.use('/webhook', createWebhookRouter(db))
  app.use('/api', createVerifyRouter(db))

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({error: 'Not found'})
  })

  // Global error handler
  app.use((err, _req, res, _next) => {
    console.error(`[ERROR] ${err.stack || err.message}`)
    res.status(500).json({error: 'Internal server error'})
  })

  // Expose db for testing cleanup
  app.locals.db = db

  return app
}

// Only start the server if this file is run directly (not imported for testing)
const isMainModule = process.argv[1]?.endsWith('index.js')

if (isMainModule) {
  // Load .env
  const dotenv = await import('dotenv')
  dotenv.config()

  const PORT = process.env.PORT || 6767
  const app = createApp()

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(``)
    console.log(`┌─────────────────────────────────────────────┐`)
    console.log(`│  Traderline Backend — Running on port ${PORT}  │`)
    console.log(`├─────────────────────────────────────────────┤`)
    console.log(`│  POST /webhook/stripe   — Stripe webhook    │`)
    console.log(`│  POST /api/verify       — License verify    │`)
    console.log(`│  POST /api/heartbeat    — Heartbeat check   │`)
    console.log(`│  GET  /health           — Health check      │`)
    console.log(`└─────────────────────────────────────────────┘`)
    console.log(``)

    // Start automatic backups (every 6h, keep last 30)
    startBackupScheduler()
  })

  // Graceful shutdown
  const shutdown = signal => {
    console.log(`\n[${signal}] Shutting down gracefully...`)
    server.close(() => {
      const db = app.locals.db
      if (db) {
        db.close()
        console.log('[shutdown] Database closed.')
      }
      console.log('[shutdown] Server closed.')
      process.exit(0)
    })

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('[shutdown] Forced exit after timeout')
      process.exit(1)
    }, 10000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Unhandled errors
  process.on('uncaughtException', err => {
    console.error('[FATAL] Uncaught exception:', err)
    shutdown('UNCAUGHT_EXCEPTION')
  })

  process.on('unhandledRejection', reason => {
    console.error('[FATAL] Unhandled rejection:', reason)
    shutdown('UNHANDLED_REJECTION')
  })
}
