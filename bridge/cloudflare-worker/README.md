# Trello Connector Bridge

Small Cloudflare Worker that owns the Trello app key and proxies Trello API
requests for the Freshworks app.

## Deploy

```sh
cd bridge/cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put TRELLO_APP_KEY
npx wrangler deploy
```

The Freshworks app has the deployed Worker host baked into its client and
server code:

```txt
trello-connector-bridge.akashram-trello-bridge.workers.dev
```

Users only connect with Trello OAuth during install. They do not enter the
Trello app key or the bridge host.

## Contract

The Freshworks app calls:

```txt
GET    /trello/authorize-url?return_url=...
GET    /trello/members/me
GET    /trello/members/me/boards
GET    /trello/boards/:id/members
GET    /trello/boards/:id/labels
GET    /trello/boards/:id/lists
GET    /trello/lists/:id/cards
POST   /trello/cards
PUT    /trello/cards/:id
POST   /trello/cards/:id/actions/comments
POST   /trello/cards/:id/idMembers
POST   /trello/cards/:id/idLabels
POST   /trello/tokens/webhooks
DELETE /trello/webhooks/:id
```

All proxy endpoints except `/trello/authorize-url` expect:

```txt
Authorization: Bearer <trello_token>
```
