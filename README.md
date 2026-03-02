# Traderline License Backend

License verification backend for the Traderline desktop app.

## Quick Start (Development)

```bash
cp .env.example .env
# Fill in your Stripe keys in .env
npm install
npm run dev
```

Server runs on `http://localhost:6767`

## Endpoints

| Method | Path              | Description                       |
| ------ | ----------------- | --------------------------------- |
| `POST` | `/webhook/stripe` | Stripe webhook for payment events |
| `POST` | `/api/verify`     | Verify license on app login       |
| `POST` | `/api/heartbeat`  | Periodic session re-validation    |
| `GET`  | `/health`         | Health check                      |

## Stripe Setup

### Payment Links

Create Stripe payment links with:

1. **Price** — set to either the monthly or lifetime price ID
2. **Custom fields:**
   - `App Key` (text) — user's Betfair app key
   - `Login Username` (text) — user's Betfair login username

The webhook will:

- Fetch the price ID from the checkout session to determine the plan (monthly/lifetime)
- Extract the custom fields and store them on the license
- Wait for `payment_intent.succeeded` for SEPA/bank transfers before granting access

### Webhook Configuration

In Stripe Dashboard → Developers → Webhooks:

- URL: `https://your-domain.com/webhook/stripe`
- Events: `checkout.session.completed`, `payment_intent.succeeded`

## Admin CLI (Terminal UI)

SSH into the server and run:

```bash
npm run admin
```

This opens an interactive terminal UI where you can:

| Key | Action                                                   |
| --- | -------------------------------------------------------- |
| `1` | List all licenses with status, plan, and device count    |
| `2` | Search users by email, app key, or Stripe ID             |
| `3` | Grant new license (monthly / lifetime / custom days)     |
| `4` | Revoke a license (user locked out on next heartbeat)     |
| `5` | Reactivate a previously revoked license                  |
| `6` | Extend a license (30d / 90d / 365d / lifetime / custom)  |
| `7` | View full license details with devices and activity logs |
| `8` | View recent verification logs                            |

> **Security:** The admin CLI connects directly to the SQLite database file. It has no HTTP endpoint — it's only
> accessible via SSH on the server.

## Deploy to Hetzner

```bash
# 1. Clone repo to server
git clone <repo-url> && cd <repo>

# 2. Create .env with production values
cp .env.example .env
nano .env

# 3. Start with Docker
docker compose up -d

# 4. Check health
curl http://localhost:6767/health

# 5. Admin access (SSH into server first)
docker compose exec backend node src/admin.js
```

### With Nginx reverse proxy (recommended)

```nginx
server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Tests

```bash
npm test
```
