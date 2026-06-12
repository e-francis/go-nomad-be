# go-nomad-be

Fastify + TypeScript backend for go Nomad. Proxies requests to the Gemini API so
the API key never reaches the browser.

## Setup

```bash
npm install
cp .env.example .env   # then fill in GEMINI_API_KEY
npm run dev
```

## Endpoints

- `GET /health` — health check
- `POST /api/plan` — body `{ origin, destination, duration }` → travel plan
- `POST /api/packing` — body `{ destination, duration, bestTime }` → packing list
- `POST /api/phrases` — body `{ destination }` → local phrases

## Docker

Build and run standalone:

```bash
cp .env.example .env   # then fill in GEMINI_API_KEY
docker build -t go-nomad-be .
docker run --env-file .env -p 4000:4000 go-nomad-be
```

To run alongside the frontend, see the `docker-compose.yml` in
[go-nomad-fe](../go-nomad-fe).
