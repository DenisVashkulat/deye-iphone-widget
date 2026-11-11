# Deye iPhone Widget — Cloudflare migration

This branch adds a Cloudflare Worker backend while keeping the existing Netlify files intact.

## Cloudflare resources

1. Create a Cloudflare D1 database named `deye-widget-cache`.
2. Open the database Console and execute the SQL in `migrations/0001_create_snapshots.sql`.
3. Copy the D1 database ID into `wrangler.jsonc`, replacing `REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID`.
4. Connect this repository's `cloudflare-migration` branch to Cloudflare Workers Builds, or deploy with Wrangler.

## Worker secrets / variables

Set these in Worker Settings → Variables and Secrets:

- `DEYE_APP_ID` (secret or variable)
- `DEYE_APP_SECRET` (secret)
- `DEYE_EMAIL` (secret)
- `DEYE_PASSWORD` (secret)
- `DEYE_STATION_ID` = `62913718`
- `DEYE_DEVICE_SN` = `2608156594`
- `BATTERY_CAPACITY_KWH` = `5.12`
- `BATTERY_RESERVE_PERCENT` = `10`
- Optional `DEYE_BASE_URL` = `https://eu1-developer.deyecloud.com`

Never commit secrets to GitHub.

## Routes

- `/` — dashboard
- `/api/status` — latest cached Deye snapshot
- Cron Trigger — refreshes Deye data every minute

The dashboard reads `/api/status`. The existing Netlify backend remains in the repository and is not deleted.

## Free-plan capacity

The current Cloudflare Workers Free allowance includes 100,000 requests/day. D1 Free includes 5 million rows read/day and 100,000 rows written/day. This design writes one snapshot row per minute (about 1,440 row writes/day) and reads one row per dashboard request, so it is comfortably below those published quotas for normal personal use. Limits can change; monitor usage in Cloudflare.

Official limits:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/

This branch is a migration draft; do not switch the live iPhone widget until the Worker is deployed and tested.


## DTEK address-level outage notices (Kyiv)

The dashboard has a separate address-level endpoint for **м. Київ, вул. Академіка Заболотного, 58 (ввід 1)**. It reads the house entry from DTEK Kyiv Electric Networks' AJAX response, including the published reason, start time and estimated end time where available. This is separate from the YASNO planned schedule for group 29.1 and from the inverter's actual grid status.

The DTEK website may require a valid browser session because of its anti-bot protection. Configure these as **Worker Secrets** (never commit them):

- `DTEK_SESSION_COOKIE` — the complete Cookie header value from a valid session on `https://www.dtek-kem.com.ua/ua/shutdowns` (cookie names and values joined with `; `).
- `DTEK_CSRF_TOKEN` — the page's `meta[name="csrf-token"]` value from the same session.

Do not paste these values into chat or GitHub. Add them in Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets → Add secret. The session may expire; if the endpoint reports a WAF/session error, refresh both secrets together. The dashboard reports unavailable data rather than treating a failed request as “no outage”.

The address endpoint is polled by the page every 5 minutes. The entrance is shown as address metadata; DTEK's returned outage record is at house-number level, not separately per entrance.
