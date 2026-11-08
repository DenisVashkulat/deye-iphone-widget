# Deye iPhone Widget — Cloudflare migration

This branch adds a Cloudflare Worker backend while keeping the existing Netlify files intact.

## Cloudflare resources

1. Create a Workers KV namespace named `DEYE_CACHE`.
2. Copy its namespace ID into `wrangler.jsonc`, replacing `REPLACE_WITH_CLOUDFLARE_KV_NAMESPACE_ID`.
3. Connect this repository's `cloudflare-migration` branch to Cloudflare Workers Builds, or deploy with Wrangler.

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
- `/api/status` — cached Deye snapshot
- Cron Trigger — refreshes Deye data every minute

The dashboard now reads `/api/status`. The existing Netlify backend remains in the repository and is not deleted.

## Free-plan notes

Cloudflare Workers Free currently has a daily request quota and a 10 ms CPU limit per invocation. Workers KV Free has daily read/write quotas. A one-minute cron uses about 1,440 KV writes per day if every run writes a snapshot, which is above the published 1,000-write daily free quota. Before enabling the minute cron on a free account, adjust the architecture to avoid a KV write on every run or use a storage option whose free allowance fits the workload. See current Cloudflare limits and KV pricing:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/kv/platform/pricing/

This branch is a migration draft; do not switch the live widget until the Cloudflare Worker is deployed and tested.
