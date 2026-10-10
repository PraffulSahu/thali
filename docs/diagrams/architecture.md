# Architecture diagrams

All diagrams are Mermaid and render on GitHub and most Markdown viewers. They describe what the code
does (services in `services/*`, compose in `docker-compose.yml`). Companion docs: [HLD](../02-HLD.md),
[LLD](../03-LLD.md), [ADRs](../04-ADR.md).

## 1. System architecture (local full stack)

```mermaid
flowchart LR
  subgraph Browser
    SPA["React SPA<br/>consumer / restaurant / partner / admin"]
  end

  subgraph Edge
    NGX["web (nginx) :5173<br/>SPA + /api proxy"]
    GW["gateway :8080<br/>native node:http proxy, rate limits,<br/>/api/v1/meta, /api/docs, admin health"]
  end

  subgraph Services["Domain services (private network)"]
    ID["identity :4001<br/>OTP, admin+MFA, JWT/JWKS, audit"]
    MK["marketplace :4002<br/>restaurants, menu, stock holds,<br/>coupons, memberships"]
    OR["orders :4003<br/>cart, checkout saga, child orders,<br/>support tickets"]
    PY["payments :4004<br/>intents, webhooks, refunds,<br/>ledger, payouts"]
    DL["delivery :4005<br/>partners, dispatch, codes, tracking"]
    NT["notifications :4006<br/>SMS/email/in-app, SSE hub"]
  end

  subgraph Data
    MG[("MongoDB rs0<br/>thali_identity ... thali_notifications<br/>one DB + one user per service")]
    RD[("Redis 7 AOF<br/>streams, locks, rate limits,<br/>pub/sub, revocation keys")]
    S3[("S3 / MinIO<br/>thali-public, thali-private")]
  end

  subgraph Providers["External providers (adapters)"]
    RZP["Razorpay<br/>mock in demo"]
    TW["Twilio SMS<br/>mock in demo"]
    RS["Resend email<br/>Mailpit in demo"]
    GM["Google Maps<br/>haversine in demo"]
  end

  SPA -->|HTTPS /api/v1 + SSE| NGX --> GW
  GW --> ID & MK & OR & PY & DL & NT
  ID & MK & OR & PY & DL & NT --> MG
  ID & MK & OR & PY & DL & NT --> RD
  GW --> RD
  MK & DL --> S3
  SPA -. presigned PUT/GET .-> S3
  PY <--> RZP
  RZP -- "webhook (raw body, HMAC)" --> GW
  NT --> TW & RS
  TW & RS -- "status webhooks" --> GW
  MK & DL --> GM
```

Notes
- Only `web`, `gateway`, Mailpit and MinIO publish host ports. Mongo, Redis and the six services are on the
  compose network only (the `debug` profile adds a loopback forwarder).
- `/internal/*` is never routed by the gateway; services call each other directly with HS256 service tokens
  (`iss=<caller>`, `aud=<callee>`, 60 s) signed with `INTERNAL_SERVICE_SECRET`.
- A service reads and writes only its own database. Cross-service data moves through internal HTTP or events.

## 2. Synchronous internal calls

```mermaid
flowchart LR
  OR[orders] -->|"quote, coupons/validate,<br/>memberships/benefits, reservations"| MK[marketplace]
  OR -->|"payment-intents, reconcile,<br/>by-reference"| PY[payments]
  MK -->|"orders/stats, checkouts/:id/status"| OR
  MK -->|"payment-intents (membership)"| PY
  MK -->|"users roles, users/:id"| ID[identity]
  PY -->|"restaurants/:id (ownership)"| MK
  DL[delivery] -->|"users/:id, users/:id/roles"| ID
  ID -->|"notifications/otp"| NT[notifications]
  ID -->|"cart/merge"| OR
  NT -->|"users/:id"| ID
  NT -->|"orders/child/:id"| OR
  NT -->|"dead-letters list/replay"| ALL["identity, marketplace, orders,<br/>payments, delivery"]
  GW[gateway] -->|"health/details"| ALL
  GW --> NT
```

## 3. Event backbone (transactional outbox + Redis Streams)

```mermaid
flowchart LR
  subgraph Producers["Producers (state change + outbox row in ONE Mongo transaction)"]
    P1[identity]
    P2[marketplace]
    P3[orders]
    P4[payments]
    P5[delivery]
    P6[notifications]
  end
  OB[("outbox collection<br/>publishedAt null = pending")]
  RL["relay (leader-locked, 500 ms)<br/>XADD events.DOMAIN MAXLEN ~100000"]
  subgraph Streams["Redis Streams"]
    S1["events.identity"]
    S2["events.marketplace"]
    S3["events.orders"]
    S4["events.payments"]
    S5["events.delivery"]
    S6["events.notifications"]
    DLQ["dlq.SERVICE"]
  end
  subgraph Consumers["Consumer groups cg.SERVICE (inbox dedupe in same txn)"]
    C1["orders: payments, delivery, marketplace"]
    C2["payments: orders"]
    C3["delivery: orders"]
    C4["marketplace: orders, payments"]
    C5["notifications: identity, marketplace, orders, payments, delivery"]
    C6["identity: audit.recorded from all six"]
  end
  Producers --> OB --> RL --> Streams
  S1 & S2 & S3 & S4 & S5 & S6 --> Consumers
  Consumers -- "5 handler failures" --> DLQ
  DLQ --> DLC[("dead_letters collection<br/>admin list + replay")]
```

Delivery guarantee: at-least-once publish (a crash between XADD and the `publishedAt` mark republishes),
exactly-once effect (inbox `_id = eventId`, written in the same transaction as the handler's writes).
Retry backoff 1 s, 2 s, 4 s ... up to 5 handler attempts, then dead-letter. Mongo or Redis outages are
treated as infrastructure errors: the consumer pauses and resumes, it does not burn handler attempts.

## 4. Real-time path (SSE)

```mermaid
sequenceDiagram
  autonumber
  participant SPA
  participant GW as gateway
  participant NT as notifications
  participant R as Redis pub/sub
  participant DL as delivery
  SPA->>GW: POST /api/v1/realtime/ticket (Bearer)
  GW->>NT: proxied
  NT-->>SPA: 201 {ticket, expiresInSec 30}
  SPA->>GW: GET /api/v1/realtime/stream?ticket=...
  GW->>NT: streamed, unbuffered, no compression
  NT-->>SPA: event-stream (retry 5000, ": ping" every 20 s)
  DL->>R: PUBLISH rt:user:ID delivery.location (ephemeral)
  R-->>NT: message
  NT-->>SPA: event: delivery.location
  Note over SPA: On disconnect the SPA polls the REST resource every 10 s
```

## 5. Deployment topology (recommended staging / production)

```mermaid
flowchart TB
  U[Users] --> CF["CDN / WAF (optional)"] --> ALB["ALB, TLS termination"]
  ALB -->|"/ (SPA, static)"| WEB["web service (nginx image)<br/>or S3 + CloudFront"]
  ALB -->|"/api/*, /.well-known/*"| GW["gateway (ECS Fargate, 2+ tasks)"]
  subgraph VPC["Private subnets"]
    GW --> SVC["identity, marketplace, orders,<br/>payments, delivery, notifications<br/>(ECS services, 2+ tasks each, service discovery)"]
    SVC --> ATLAS[("MongoDB Atlas replica set<br/>PITR backups, per-service DB users")]
    SVC --> REDIS[("Managed Redis with AOF<br/>ElastiCache / equivalent")]
  end
  SVC --> S3[("S3: public + private buckets")]
  SVC --> EXT["Razorpay, Twilio, Resend, Google Maps"]
  SM["Secrets Manager"] -.-> SVC & GW
  EXT -- "webhooks to /api/v1/webhooks/*" --> ALB
```

See [06-deployment.md](../06-deployment.md) for the details behind each box.
