# Checkout, payment, order, refund and delivery flows

Mermaid sequence and flow diagrams of the money and order paths as implemented. State machines are in
[state-machines.md](state-machines.md). Abbreviations: OR orders, MK marketplace, PY payments,
DL delivery, NT notifications, RZ Razorpay (or the mock provider in demo).

## 1. Checkout to PLACED (happy path)

```mermaid
sequenceDiagram
  autonumber
  participant SPA
  participant OR as orders
  participant MK as marketplace
  participant PY as payments
  participant RZ as Razorpay / mock
  SPA->>OR: POST /api/v1/checkouts (Idempotency-Key)
  OR->>MK: POST /internal/quote (items with lineRef, drop point)
  MK-->>OR: per restaurant: open, serviceable, fees, ETA, priced lines, stockOk
  OR->>MK: POST /internal/coupons/validate and /internal/memberships/benefits
  OR->>OR: priceCheckout() (integer paise, pro-rata allocation)
  OR->>MK: POST /internal/reservations (checkoutId, TTL 900 s): atomic stock + coupon + membership hold
  OR->>OR: txn: CheckoutGroup + ChildOrders AWAITING_PAYMENT + outbox checkout.created
  OR->>PY: POST /internal/payment-intents (checkoutId, amountPaise)
  PY->>RZ: create provider order (receipt, notes)
  PY-->>OR: providerOrderId, keyId or demoPayUrl
  OR-->>SPA: 201 checkout AWAITING_PAYMENT + payment init
  SPA->>RZ: Razorpay Checkout (hosted) or demo-pay page
  RZ-->>PY: webhook payment.captured (X-Razorpay-Signature over RAW body)
  PY->>PY: verify HMAC, dedupe event id, check amount/currency/receipt
  PY->>PY: txn: intent CAPTURED + outbox payment.captured
  PY--)OR: event payment.captured
  OR->>OR: txn: inbox + children PLACED (acceptBy = now + 300 s) + outbox order.placed x N, checkout.confirmed
  OR--)MK: event checkout.confirmed: reservations COMMITTED, coupon REDEEMED, membership usage USED
  OR--)NT: event order.placed: customer and restaurant notified
  SPA->>OR: GET /api/v1/checkouts/:id (poll) or SSE order.updated
```

## 2. Failure branches

```mermaid
flowchart TD
  A["Checkout AWAITING_PAYMENT<br/>stock + coupon held for CHECKOUT_TTL_SEC (900 s)"] --> B{"What reaches payments?"}
  B -->|"payment.captured, amount == total"| P["children PLACED<br/>reservations committed"]
  B -->|"payment.failed"| F["Mirror only: paymentStatus=FAILED, timeline entry.<br/>Checkout stays AWAITING_PAYMENT, hold kept,<br/>customer may retry the SAME provider order"]
  F -->|"retry captured"| P
  F -->|"no retry, expiresAt passes"| S
  B -->|"nothing (abandoned, webhook lost)"| S["Sweeper (every 30 s, leader-locked)<br/>checkout past expiresAt"]
  S --> R["ALWAYS reconcile with payments first<br/>POST /internal/payment-intents/:id/reconcile"]
  R -->|"CAPTURED, amount == total"| P
  R -->|"CAPTURED with other amount, REFUNDED"| L["EXPIRED + checkout.released<br/>+ checkout.late_payment"]
  R -->|"AUTHORIZED within AUTHORIZED_GRACE_SEC"| W["Wait: payments auto-captures<br/>(after AUTHORIZED_CAPTURE_AFTER_SEC)"]
  R -->|"CREATED / FAILED / no intent"| E["EXPIRED + checkout.released<br/>marketplace releases stock, coupon, membership"]
  R -->|"payments unreachable"| K["Skip, retry next tick<br/>(never expire without reconciling)"]
  P2["payment.captured arrives AFTER expiry"] --> L
  L --> RF["payments: full refund LATE_PAYMENT<br/>idempotency key refund:checkoutId:LATE_PAYMENT"]
  O["orders service down when captured"] -.-> Q["event waits in outbox / stream;<br/>processed idempotently on recovery"] -.-> P
```

Rules worth remembering
- A duplicate webhook (same event id, or same body hash when the provider sends no id) is stored as
  `IGNORED_DUPLICATE` and never produces a second event.
- An event that implies an earlier state (for example `payment.authorized` after CAPTURED, or `payment.failed`
  after CAPTURED) is stored as `IGNORED_STALE` and alerted, never applied.
- `POST /payments/:intentId/verify` (customer) can only trigger a provider reconcile. It never marks an
  intent paid by itself.
- A different amount, currency or receipt than the intent is `REJECTED_MISMATCH` with an
  `alert: PAYMENT_MISMATCH` error log and no event.

## 3. Partial rejection and refund

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer
  participant RA as Restaurant A
  participant RB as Restaurant B
  participant OR as orders
  participant PY as payments
  participant RZ as Razorpay / mock
  participant MK as marketplace
  participant NT as notifications
  Note over OR: Checkout PAID_PLACED, children A1 and B1 PLACED
  RA->>OR: POST /owner/orders/A1/accept {prepMinutes}
  OR--)NT: order.accepted (A1)
  RB->>OR: POST /owner/orders/B1/reject {reason}
  OR->>OR: B1 REJECTED, refundStatus REQUESTED, outbox order.rejected {refundPaise = B1 total}
  OR--)PY: order.rejected
  OR--)MK: order.rejected: restore B1 stock
  PY->>PY: txn: reserve refund (refundReservedPaise += amount, must stay <= captured)
  PY->>PY: Refund REQUESTED (key refund:B1:RESTAURANT_REJECTED)
  PY->>RZ: POST /payments/:id/refund (X-Refund-Idempotency)
  RZ-->>PY: processed, or refund.processed webhook
  PY->>PY: Refund SUCCEEDED, intent PARTIALLY_REFUNDED
  PY--)OR: refund.succeeded: B1.refundStatus SUCCEEDED, refundedPaise
  OR--)NT: customer: "Restaurant B declined, refund of the amount initiated. A continues."
  Note over OR: Parent derived status: IN_PROGRESS, then PARTIALLY_COMPLETED when A1 is DELIVERED
  C->>OR: GET /orders/:checkoutId shows per-child status, refund state, totals
```

Refund failure handling

```mermaid
flowchart TD
  R["Refund REQUESTED"] --> W["worker claims: PROCESSING (lease)<br/>provider call outside any transaction"]
  W -->|"processed / refund.processed"| OK["SUCCEEDED<br/>intent PARTIALLY_REFUNDED or REFUNDED<br/>refund.succeeded"]
  W -->|"timeout, 5xx, 429, 409: UNCERTAIN"| U["FAILED, reservation KEPT<br/>retry with backoff 1m, 2m, 4m... same provider key"]
  U -->|"attempt 5 reached"| FF["FAILED final: refund.failed<br/>shows in admin finance for manual retry"]
  U -->|"retry succeeds"| OK
  W -->|"4xx / provider says failed: DEFINITIVE"| D["FAILED final, reservation RELEASED<br/>refund.failed, no auto retry"]
  FF --> M["Admin: POST /admin/finance/refunds/:id/retry<br/>(re-reserves atomically)"]
  D --> M
  M --> W
  W -->|"PROCESSING longer than REFUND_POLL_AFTER_SEC"| POLL["fetchRefund poll decides"]
  POLL --> OK
```

## 4. Delivery flow

```mermaid
sequenceDiagram
  autonumber
  participant RA as Restaurant
  participant OR as orders
  participant DL as delivery
  participant P as Partner app
  participant C as Customer
  participant PY as payments
  RA->>OR: accept (prepMinutes)
  OR--)DL: order.accepted (pickup, drop, pickup code, delivery code)
  DL->>DL: DeliveryJob PENDING_ASSIGNMENT (codes stored as hashes)
  loop dispatcher every 5 s, rounds up to MAX_DISPATCH_ROUNDS (5)
    DL->>DL: eligible partners: APPROVED, online, ping < 120 s, within radius 3/5/8 km, batching rules
    DL-->>P: offers (TTL 45 s), SSE partner.offer
  end
  P->>DL: POST /deliveries/offers/:id/accept
  DL->>DL: ONE txn: offer ACCEPTED, job ASSIGNED, partner capacity, cancel other offers
  Note over DL: Loser gets 409 ASSIGNMENT_TAKEN / OFFER_EXPIRED / CAPACITY_EXCEEDED
  DL--)OR: delivery.assigned
  P->>DL: arrived, then pickup {code from restaurant} (5 wrong codes = locked, admin)
  DL--)OR: delivery.picked_up: child PICKED_UP
  P->>DL: start
  DL--)OR: delivery.started: child OUT_FOR_DELIVERY
  loop while online
    P->>DL: POST /partner/location (1 per 3 s)
    DL-->>C: SSE delivery.location (ephemeral, last updated Xs, stale after 60 s)
  end
  P->>DL: deliver {delivery code from customer}
  DL--)OR: delivery.delivered: child DELIVERED, parent derived
  OR--)PY: order.delivered: ledger ORDER_EARNING, COMMISSION, DELIVERY_EARNING
  Note over DL: No taker after 5 rounds: exception=true + delivery.exception, admin assigns manually (TMS)
```
