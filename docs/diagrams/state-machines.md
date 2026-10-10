# State machines

Source of truth: `packages/contracts/src/state-machines.ts` (transition tables with the allowed actors),
enforced in every service by `assertTransition`. The diagrams below are drawn from those tables.
`SYSTEM` means an event consumer, sweeper or worker; `ADMIN` actions are audited.

## 1. Child order (one per restaurant)

```mermaid
stateDiagram-v2
  [*] --> AWAITING_PAYMENT
  AWAITING_PAYMENT --> PLACED: SYSTEM payment captured
  AWAITING_PAYMENT --> PAYMENT_FAILED: SYSTEM
  AWAITING_PAYMENT --> EXPIRED: SYSTEM sweeper after reconcile
  PLACED --> ACCEPTED: RESTAURANT or ADMIN, within acceptBy
  PLACED --> REJECTED: RESTAURANT, ADMIN, SYSTEM timeout RESTAURANT_TIMEOUT
  PLACED --> CANCELLED: CUSTOMER or ADMIN
  ACCEPTED --> PREPARING: RESTAURANT
  ACCEPTED --> READY_FOR_PICKUP: RESTAURANT
  PREPARING --> READY_FOR_PICKUP: RESTAURANT
  ACCEPTED --> CANCELLED: ADMIN
  PREPARING --> CANCELLED: ADMIN
  READY_FOR_PICKUP --> CANCELLED: ADMIN
  ACCEPTED --> PICKED_UP: SYSTEM delivery picked up
  PREPARING --> PICKED_UP: SYSTEM
  READY_FOR_PICKUP --> PICKED_UP: SYSTEM
  PICKED_UP --> OUT_FOR_DELIVERY: SYSTEM delivery started
  PICKED_UP --> DELIVERED: SYSTEM
  OUT_FOR_DELIVERY --> DELIVERED: SYSTEM
  PICKED_UP --> DELIVERY_FAILED: SYSTEM or ADMIN
  OUT_FOR_DELIVERY --> DELIVERY_FAILED: SYSTEM or ADMIN
  DELIVERY_FAILED --> CANCELLED: ADMIN with refundPaise
  DELIVERED --> [*]
  REJECTED --> [*]
  CANCELLED --> [*]
  PAYMENT_FAILED --> [*]
  EXPIRED --> [*]
```

Terminal: DELIVERED, REJECTED, CANCELLED, PAYMENT_FAILED, EXPIRED. DELIVERY_FAILED is deliberately not
terminal (it waits for an admin decision). A restaurant acting after `acceptBy` gets 409
`ORDER_ACCEPT_WINDOW_EXPIRED`. The admin transition endpoint (`POST /api/v1/admin/orders/child/:childId/transition`)
can only perform the rows whose actors include ADMIN.

## 2. Checkout group (derived from its children)

```mermaid
stateDiagram-v2
  [*] --> AWAITING_PAYMENT
  AWAITING_PAYMENT --> PAID_PLACED: all children PLACED
  AWAITING_PAYMENT --> PAYMENT_FAILED: all children PAYMENT_FAILED
  AWAITING_PAYMENT --> EXPIRED: all children EXPIRED
  PAID_PLACED --> IN_PROGRESS: any child moves on
  PAID_PLACED --> COMPLETED: all DELIVERED
  PAID_PLACED --> PARTIALLY_COMPLETED: all terminal, some DELIVERED
  PAID_PLACED --> CANCELLED: all terminal, none DELIVERED
  IN_PROGRESS --> COMPLETED: all DELIVERED
  IN_PROGRESS --> PARTIALLY_COMPLETED: all terminal, some DELIVERED
  IN_PROGRESS --> CANCELLED: all terminal, none DELIVERED
```

`deriveCheckoutStatus(children, current)`: any AWAITING_PAYMENT keeps AWAITING_PAYMENT; all PAYMENT_FAILED or
all EXPIRED map to the same checkout state; when all children are terminal the result is COMPLETED,
PARTIALLY_COMPLETED or CANCELLED; otherwise all PLACED is PAID_PLACED and anything else IN_PROGRESS.
A DELIVERY_FAILED child is non-terminal, so the parent stays IN_PROGRESS until an admin cancels it.

## 3. Payment intent

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> AUTHORIZED: provider authorized
  CREATED --> CAPTURED: captured without a seen authorization
  AUTHORIZED --> CAPTURED: webhook, or reconcile capture after 300 s
  CREATED --> FAILED
  AUTHORIZED --> FAILED
  FAILED --> CAPTURED: later attempt on the same provider order
  CAPTURED --> PARTIALLY_REFUNDED
  PARTIALLY_REFUNDED --> PARTIALLY_REFUNDED: further partial refunds
  PARTIALLY_REFUNDED --> REFUNDED
  CAPTURED --> REFUNDED
```

All transitions are SYSTEM. Out-of-order events that imply an earlier state are recorded as
`IGNORED_STALE` and do not change the intent.

## 4. Refund

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> PROCESSING: worker claim
  REQUESTED --> FAILED: cannot reserve or definitive rejection
  PROCESSING --> SUCCEEDED: provider processed
  PROCESSING --> FAILED: uncertain or definitive failure
  FAILED --> PROCESSING: automatic retry up to 5, or ADMIN retry
```

## 5. Delivery job

```mermaid
stateDiagram-v2
  [*] --> PENDING_ASSIGNMENT
  PENDING_ASSIGNMENT --> OFFERED: SYSTEM dispatch round
  OFFERED --> PENDING_ASSIGNMENT: SYSTEM all offers expired
  PENDING_ASSIGNMENT --> ASSIGNED: PARTNER accept or ADMIN assign
  OFFERED --> ASSIGNED: PARTNER accept or ADMIN assign
  ASSIGNED --> AT_PICKUP: PARTNER arrived
  ASSIGNED --> PENDING_ASSIGNMENT: PARTNER drop, ADMIN unassign, SYSTEM partner suspended
  AT_PICKUP --> PENDING_ASSIGNMENT: PARTNER, ADMIN, SYSTEM
  AT_PICKUP --> PICKED_UP: PARTNER with pickup code
  PICKED_UP --> OUT_FOR_DELIVERY: PARTNER start
  OUT_FOR_DELIVERY --> DELIVERED: PARTNER with delivery code
  PICKED_UP --> FAILED: PARTNER or ADMIN with reason
  OUT_FOR_DELIVERY --> FAILED: PARTNER or ADMIN with reason
  PENDING_ASSIGNMENT --> CANCELLED: SYSTEM or ADMIN order cancelled
  OFFERED --> CANCELLED
  ASSIGNED --> CANCELLED
  AT_PICKUP --> CANCELLED
  PICKED_UP --> CANCELLED
  OUT_FOR_DELIVERY --> CANCELLED
  DELIVERED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

After `MAX_DISPATCH_ROUNDS` (5) with no taker the job keeps its status but is flagged `exception=true`
(`delivery.exception`), auto-dispatch stops and an admin assigns manually. Five wrong handover codes lock the
job (HTTP 423); only an admin fail or reassignment clears it.

## 6. Delivery offer

```mermaid
stateDiagram-v2
  [*] --> OFFERED
  OFFERED --> ACCEPTED: first atomic accept wins
  OFFERED --> REJECTED: partner
  OFFERED --> EXPIRED: TTL 45 s
  OFFERED --> CANCELLED: job taken, cancelled or reassigned
```

## 7. Restaurant onboarding

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> VERIFICATION_PENDING: RESTAURANT submits, verification email sent
  VERIFICATION_PENDING --> APPROVAL_PENDING: SYSTEM business email verified
  APPROVAL_PENDING --> APPROVED: ADMIN
  APPROVAL_PENDING --> REJECTED: ADMIN with reason
  REJECTED --> APPROVAL_PENDING: RESTAURANT resubmits, email still verified
  APPROVAL_PENDING --> VERIFICATION_PENDING: RESTAURANT changes business email
  REJECTED --> VERIFICATION_PENDING: RESTAURANT changes business email
  APPROVED --> SUSPENDED: ADMIN with reason
  SUSPENDED --> APPROVED: ADMIN reinstates
```

Email verification and admin approval are separate gates. Public discovery requires `APPROVED`, not paused,
and the restaurant location inside the same active service-area polygon as the drop point (ADR-016).

## 8. Delivery partner

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> APPROVAL_PENDING: PARTNER submits profile, vehicle, required documents
  APPROVAL_PENDING --> APPROVED: ADMIN
  APPROVAL_PENDING --> REJECTED: ADMIN with reason
  REJECTED --> APPROVAL_PENDING: PARTNER resubmits
  APPROVED --> SUSPENDED: ADMIN, forces offline, cancels live offers
  SUSPENDED --> APPROVED: ADMIN reinstates
```

Only `APPROVED` partners can go online or receive offers (403 `PARTNER_NOT_APPROVED` otherwise). Going offline
while holding jobs returns 409 `PARTNER_HAS_ACTIVE_JOBS` (ADR-020). Demo mode may mark uploaded documents
`demoVerified`, but approval is always an admin action.

## 9. Notification

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> SENDING: atomic claim, attempts + 1
  SENDING --> SENT: provider accepted
  SENDING --> FAILED: retryable error, backoff 30 s doubling, cap 900 s
  FAILED --> SENDING: retry worker
  FAILED --> DEAD: attempt 6, or permanent 4xx
  SENT --> DELIVERED: provider callback
  SENT --> DEAD: bounce, undelivered
  SENDING --> SKIPPED: recipient opted out, blocked, or no address
  DEAD --> QUEUED: ADMIN retry
```
