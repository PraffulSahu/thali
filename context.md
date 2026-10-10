You are a senior full-stack engineer, product architect, and reliability-focused technical lead.

Build a complete food delivery web application using the MERN stack, mongodb and a pragmatic microservices architecture.

The goal is a working application—not just a polished interface, architecture document, or collection of disconnected APIs. Customer ordering, restaurant operations, delivery management, payments, verification, notifications, and administration must work together.

Work autonomously, make sensible assumptions, and document important decisions. Ask questions only when a missing answer genuinely blocks implementation. Continue with all work that is not blocked.

# 1. Product Goal and Working Assumptions

Build a food delivery platform for four user groups:

1. Consumers.
2. Restaurant and cloud-kitchen owners.
3. Administrators.
4. Delivery partners.

Consumers should be able to discover nearby restaurants without signing in, order from multiple restaurants, pay securely, and track their deliveries.

Restaurants should be able to onboard, get approved, manage menus, process orders, and view earnings.

Delivery partners should be able to onboard, get approved, accept deliveries, update delivery progress, and view earnings and payouts.

Administrators should be able to manage the marketplace, approvals, deliveries, support issues, financial operations, and application health.

Unless the existing repository indicates otherwise, use these assumptions:

- The initial market is India, with INR as the default currency.
- Store timestamps in UTC and display them in the relevant local timezone, initially Asia/Kolkata.
- Launch with configurable service areas rather than hardcoded city or location restrictions.
- Treat TMS as transport and delivery management. Include customer support ticket management separately.
- Design for a realistic pilot launch, with a clear path to scale. Do not introduce unnecessary enterprise complexity.

# 2. Technology Stack and Architecture

Use:

- React with TypeScript for the frontend.
- Node.js, Express, and TypeScript for backend services.
- MongoDB for persistence.
- OpenAPI/Swagger for API documentation.
- Docker and Docker Compose for local development.
- Redis where appropriate for caching and rate limiting.
- A durable background-job or messaging mechanism for asynchronous workflows.
- WebSockets or Server-Sent Events for real-time updates, with a fallback when the connection is unavailable.

Choose compatible, maintained dependencies and pin the versions used. Verify integration details against current official documentation rather than inventing APIs or configuration options.

Use a monorepo with clearly separated applications, services, and shared contracts.

A reasonable starting service structure is:

1. Identity: authentication, users, roles, verification, and sessions.
2. Marketplace: restaurants, onboarding, menus, discovery, promotions, and memberships.
3. Orders: carts, checkout orchestration, inventory reservations, and order lifecycle.
4. Payments: payment attempts, webhooks, refunds, financial records, and payout integration.
5. Delivery: partner onboarding, assignments, batching, tracking, and delivery lifecycle.
6. Notifications: SMS, email, and asynchronous notification delivery.

Use an API gateway or equivalent backend entry point.

You may refine these boundaries, but explain meaningful changes. Services must be independently runnable and deployable—not merely route folders inside one backend.

Architecture requirements:

- Each service owns its data and exposes explicit contracts.
- Do not allow services to modify another service’s collections directly.
- Shared packages may contain contracts, validation schemas, and common utilities, but should not create hidden cross-service database coupling.
- Use local transactions where appropriate and durable events or compensating actions across services.
- Do not assume a transaction can atomically cover MongoDB, a payment provider, and a message broker.
- Configure local MongoDB appropriately if the implementation depends on transactions.
- Avoid Kubernetes, service meshes, excessive service fragmentation, or advanced routing infrastructure unless a demonstrated requirement justifies them.

# 3. Consumer Experience

## Discovery Without Authentication

Consumers must be able to:

- Browse without signing in.
- Allow location access or manually select an address or map location.
- Discover restaurants that actually serve the selected delivery address.
- View food categories, promotional banners, restaurant images, cuisine, availability, estimated delivery time, and delivery charges.
- Search restaurants and menu items.
- Filter by vegetarian/non-vegetarian food, cuisine, price, availability, and other useful attributes.
- Sort by relevant criteria such as distance, price, delivery estimate, or rating when genuine rating data exists.
- View restaurant details, menu categories, item descriptions, prices, availability, customization options, and add-ons.

Do not confuse “nearby” with “deliverable.” Check configured service areas and delivery eligibility.

Do not fabricate ratings, delivery estimates, or restaurant availability. Demo values must be clearly identified as demo data.

## Authentication and Profile

Require phone-based OTP authentication before placing an order.

Include:

- Phone-number normalization and validation.
- OTP expiry, resend cooldowns, attempt limits, and abuse protection.
- Guest-cart preservation after authentication.
- Profile editing.
- Saved addresses and a default address.
- Order history and order details.
- Reordering with fresh checks for prices, availability, and serviceability.
- Notification preferences and sign-out.

## Cart and Checkout

Support:

- Items from multiple restaurants in one cart.
- Item customizations, add-ons, quantity changes, and removal.
- Default or newly added delivery addresses.
- Coupons and membership benefits.
- Clear price breakdowns before payment.
- Secure online payment.
- Order confirmation, tracking, cancellation eligibility, and support access.

Validate prices, stock, restaurant opening status, coupon eligibility, and address serviceability on the server immediately before checkout.

## Membership

Implement a simple, useful membership system with:

- Configurable plans, prices, duration, and benefits.
- Membership status and expiry.
- Purchase history.
- Server-enforced eligibility and benefit limits.
- Transparent terms in the interface.

An initial prepaid membership is acceptable. Implement recurring renewal only through an explicitly supported provider workflow with customer consent and cancellation controls.

# 4. Restaurant and Cloud-Kitchen Experience

## Onboarding and Approval

Businesses must be able to register and create a store with:

- Business and restaurant name.
- Owner/contact details.
- Verified business email.
- Phone number.
- Address and map coordinates.
- Cuisine and restaurant description.
- Operating hours.
- Restaurant and menu images.
- Relevant business documents where required.
- Settlement details, collected and stored through an appropriately secured workflow.

Model email verification and administrative approval as separate requirements.

Use explicit onboarding states such as:

DRAFT → VERIFICATION_PENDING → APPROVAL_PENDING → APPROVED

Also support rejection and suspension, with reasons.

Only eligible, approved restaurants should become publicly available for ordering.

## Restaurant Dashboard and Order Management

Provide:

- Dashboard metrics calculated from actual stored records.
- Menu/category management.
- Item pricing, customizations, add-ons, availability, and stock controls.
- Store opening hours and temporary pause controls.
- Incoming order notifications.
- Order acceptance or rejection with a reason.
- Preparation-time updates.
- Ready-for-pickup updates.
- Order history.
- Earnings, deductions, refunds, and settlement visibility.

A restaurant must only access its own stores, orders, customers’ fulfillment details, and financial records.

Restrict restaurant actions to valid lifecycle transitions. Define what happens when a restaurant does not respond within the configured acceptance window.

# 5. Delivery Partner Experience

## Onboarding and Authentication

Provide:

- Phone OTP authentication.
- Partner profile creation.
- Vehicle information.
- Identity/document submission.
- Administrative approval.
- Approval, rejection, and suspension states.

Dummy identity verification is allowed only in explicitly marked demo mode. It must never silently approve real production accounts.

## Delivery Dashboard

Include:

- Online/offline availability.
- Available delivery offers or assignments.
- Accept/reject controls.
- Pickup and drop-off information.
- Navigation links or map integration.
- Pickup confirmation.
- Delivery confirmation using a suitable verification method.
- Active deliveries.
- Delivery history.
- Earnings and payout status.

Prevent multiple partners from successfully accepting the same assignment through atomic server-side controls.

## Multiple Deliveries

Support controlled delivery batching rather than unrestricted acceptance of multiple orders.

Define configurable rules for:

- Maximum active deliveries.
- Pickup and drop-off compatibility.
- Route feasibility.
- Capacity constraints.
- Estimated delay to existing customers.
- Assignment expiry and reassignment.

Provide a simple, explainable batching policy initially. Do not build a complex optimization engine before the basic delivery workflow works.

For location tracking:

- Obtain appropriate user permission.
- Send and display real location updates.
- Show the last update time and indicate stale data.
- Handle interrupted connections.
- Document browser background-tracking limitations.
- Do not simulate a moving delivery partner in live mode.

# 6. Administrator Experience

Use secure administrator authentication with strong password handling. Include MFA support and document any remaining launch requirements.

Do not allow public self-registration as an administrator.

Provide:

- Marketplace overview and operational metrics.
- Restaurant approval, rejection, suspension, and management.
- Delivery partner approval and management.
- Customer and role management.
- Order search and investigation.
- Delivery/transport management, assignment, reassignment, and exception handling.
- Coupon, banner, category, and membership configuration.
- Customer support tickets.
- Refund review and permitted financial actions.
- Restaurant and delivery-partner settlement visibility.
- Audit logs for sensitive operations.
- Application and integration health.

Health views should include service readiness, database connectivity, queue backlog, failed jobs, and relevant provider failures.

Do not display decorative “healthy” indicators without checking actual dependencies. Restrict operational details to authorized administrators and never expose secrets.

# 7. Multi-Restaurant Ordering: Mandatory Domain Design

Multi-restaurant ordering is a core requirement. Do not implement it as a normal single-restaurant order with multiple restaurant IDs attached.

Use:

- One parent checkout or order group representing the consumer’s purchase.
- One child order per restaurant.
- Separate fulfillment and delivery records where required.
- A clearly defined relationship between the payment and each child order.

Define and implement:

- Restaurant-specific subtotals and fees.
- Configurable taxes and delivery charges.
- Deterministic allocation of shared discounts.
- Membership benefit allocation.
- Independent restaurant acceptance or rejection.
- Partial cancellation and partial refunds.
- Separate delivery tracking where orders arrive independently.
- Parent-order status derived from child-order states.

Use integer minor units for monetary values. Define rounding rules and ensure line items, discounts, fees, and refunds reconcile exactly.

Example scenario that must work:

A customer pays for items from two restaurants. Restaurant A accepts; Restaurant B rejects. Restaurant A’s order continues. Restaurant B’s portion enters the correct refund workflow, and the customer sees an accurate explanation and updated totals.

Also handle:

- A restaurant closing during checkout.
- Prices or availability changing before payment.
- Competing checkouts for the last available item.
- Payment succeeding while an internal service temporarily fails.
- Duplicate checkout submissions.
- A customer leaving the payment page before the final result arrives.
- One delivery succeeding while another fails.

Use expiring reservations where needed and release them safely after payment failure, expiry, or cancellation. Include recovery for abandoned or interrupted workflows.

# 8. Order, Payment, and Delivery State Machines

Define explicit state machines and enforce them on the backend.

A child-order lifecycle may begin with:

AWAITING_PAYMENT → PLACED → ACCEPTED → PREPARING → READY_FOR_PICKUP → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED

Support appropriate alternative outcomes such as:

PAYMENT_FAILED, EXPIRED, REJECTED, and CANCELLED.

Keep payment status, refund status, order status, and delivery status distinct. They represent different facts.

For every transition, define:

- Who or what may trigger it.
- Preconditions.
- Relevant timestamps.
- Notifications or events.
- Failure and recovery behavior.
- Whether compensation or refund handling is required.

Customers, restaurants, delivery partners, and administrators must not be able to bypass lifecycle rules through direct API requests.

Do not mark an order as paid solely because the browser reached a success page.

# 9. Real External Integrations

Implement replaceable provider adapters for:

- SMS and OTP delivery.
- Business email verification and transactional email.
- Payment collection and refunds.
- Maps, geocoding, and delivery estimates where used.
- Image/document storage.
- Payouts, if actual automated disbursement is included.

For each integration:

- Choose a suitable provider and verify its current official documentation.
- Implement actual requests, authentication, response handling, and relevant callbacks.
- Document required credentials and setup.
- Separate test credentials from live credentials.
- Handle timeouts, rate limits, and provider errors.
- Track delivery or processing status where the provider supports it.
- Never expose provider secrets to the frontend.

For payments:

- Prefer provider-hosted or tokenized payment flows.
- Do not store raw card data or CVV.
- Verify webhook signatures.
- Check payment amount, currency, and internal order references.
- Deduplicate events.
- Handle delayed and out-of-order callbacks.
- Use idempotency protection for payment and refund operations.
- Reconcile uncertain payment states with the provider.
- Distinguish a requested refund from a completed refund.

For payouts:

- Distinguish internal earnings, available balance, requested payout, and confirmed payout.
- Never label a payout as completed merely because a UI button was clicked.
- Document whether payouts are provider-executed or recorded after verified manual settlement.
- Define how cancellations, refunds, and adjustments affect payable balances.

# 10. Demo Mode Versus Real Operation

Support clearly separated modes:

- Local/demo mode.
- Provider sandbox or staging mode.
- Production mode.

Demo mode may use seeded restaurants, test users, simulated location events, and mock provider adapters, but it must be visibly labeled and technically isolated.

Production must not:

- Accept a fixed/demo OTP.
- Automatically approve dummy identity documents.
- Pretend to send SMS or email.
- Treat mock payment success as a real payment.
- Display simulated delivery tracking as live tracking.
- Report fictional payouts or operational metrics.

When credentials are unavailable:

1. Implement the provider adapter and configuration.
2. Provide an explicitly labeled demo/test alternative.
3. Document the exact external setup required.
4. Mark live verification as pending.
5. Continue implementing all unblocked functionality.

Never present an untested integration as verified.

# 11. Security and Reliability

Implement security and reliability throughout the application, not as a final checklist.

Include:

- Server-side role-based and resource-level authorization.
- Strong password hashing.
- Secure session handling and revocation.
- Appropriate cookie, CORS, and CSRF protections for the chosen authentication design.
- Input validation at service boundaries.
- OTP, login, search, and checkout rate limiting.
- Sensitive-file access controls.
- File type and size validation.
- Secret management through environment or deployment configuration.
- Redaction of sensitive information from logs.
- Restricted service-to-service access.
- Auditable privileged operations.

Reliability requirements:

- Idempotent handling of retried commands and events.
- Bounded retries with backoff for appropriate operations.
- Failed-job visibility and dead-letter or equivalent recovery handling.
- Durable order and payment events.
- Atomic controls for stock, coupon usage, and assignment races.
- Clear request timeouts.
- Graceful shutdown.
- Health and readiness endpoints.
- Structured logs with correlation IDs.
- Backup and restore instructions.
- A recovery process for stuck payments, orders, and notifications.

Do not silently swallow errors or return success when the requested operation failed.

# 12. API Documentation and Data Design

Expose versioned APIs, such as `/api/v1`.

Provide OpenAPI/Swagger documentation for all implemented APIs, including:

- Authentication and permissions.
- Request and response schemas.
- Validation rules.
- Pagination and filtering.
- Error responses.
- State enums.
- Webhooks.
- Idempotency requirements.
- Realistic examples.

Document where Swagger UI and the machine-readable specification are available. Restrict production access appropriately.

Keep documentation synchronized with implementation.

Design explicit models for users, restaurant onboarding, menus, carts, checkout groups, child orders, payments, refunds, delivery assignments, partners, coupons, memberships, notifications, support tickets, and financial records.

Document:

- Data ownership.
- Relationships.
- Important indexes and unique constraints.
- Retention and deletion behavior for sensitive information.
- Financial and order-history preservation.
- Schema evolution or migration approach.

# 13. User Interface Quality

Build a responsive, mobile-first interface with distinct experiences for all four roles.

Use a consistent design system and reusable components.

Every important screen must handle:

- Loading.
- Empty results.
- Validation errors.
- API failures.
- Permission restrictions.
- Expired sessions.
- Retry and recovery paths.

Provide accessible forms, keyboard navigation, meaningful status messages, and clear order/payment progress.

Use real API-backed data in operational screens. No dead buttons, disconnected forms, fake counters, or hardcoded success messages.

Display multi-restaurant fees and separate deliveries clearly before payment.

# 14. Demo Data and Test Coverage

Provide an idempotent seed command that creates:

- Sample consumers.
- Approved and pending restaurants.
- Vegetarian and non-vegetarian menu items.
- Item customization options.
- Delivery partners with different approval and availability states.
- Coupons and memberships.
- Orders across different lifecycle states.
- Payment and refund examples.
- A clearly identified multi-restaurant checkout example.

Keep demo data and credentials out of production by default. Document safe local test access.

Add unit, integration, and end-to-end tests.

At minimum, cover:

- OTP expiry, reuse prevention, and attempt limits.
- Business email verification.
- Approval restrictions.
- Cross-user and cross-restaurant access prevention.
- Guest-cart preservation.
- Multi-restaurant checkout and exact pricing.
- Coupon limits and stock races.
- Duplicate checkout requests.
- Duplicate and out-of-order payment webhooks.
- Payment recovery after an interruption.
- Partial restaurant rejection and partial refunds.
- Delivery assignment races.
- Unauthorized state changes.
- Provider outages and notification retries.

Test that repeated events do not create duplicate logical orders, charges, refunds, or assignments.

# 15. Execution Approach

If a repository exists, inspect it first and preserve working functionality. Do not perform destructive rewrites without a clear reason.

Start with a concise implementation plan covering:

- Assumptions.
- Architecture and service ownership.
- Main data models.
- Critical state machines.
- External integrations.
- Implementation milestones.

Then begin implementation. Do not stop after planning.

Build in working vertical slices:

1. Local infrastructure, authentication, roles, and onboarding.
2. Restaurant discovery, menus, and persistent carts.
3. Checkout, payments, and restaurant order handling.
4. Delivery assignment, tracking, and completion.
5. Multi-restaurant failure handling, refunds, memberships, and administration.
6. Reliability, security, testing, and deployment verification.

The final implementation must include multi-restaurant checkout; an initial single-restaurant slice is only an intermediate milestone.

At each milestone:

- Connect the frontend to the real backend.
- Run relevant tests and build checks.
- Fix failures before expanding scope.
- Report what is working, what was verified, and what is blocked.

Use available filesystem, terminal, and testing tools. When tools are unavailable, provide the implementation and verification commands, but do not claim to have executed them.

Prioritize complete core workflows over additional decorative features.

# 16. Required Deliverables

Deliver:

- Working source code with a clear repository structure.
- Dockerfiles and Docker Compose configuration.
- `.env.example` files with explanations and no real secrets.
- Database setup, initialization, and seed scripts.
- OpenAPI/Swagger documentation.
- Automated tests and their actual execution results.
- A README with exact local startup commands.
- Provider setup instructions.
- Staging and production deployment guidance.
- Architecture and order/payment workflow diagrams.
- A concise operations runbook for common failures.
- A launch-readiness checklist separating verified functionality from pending external configuration.

# 17. Completion Criteria

The application is not complete until the following flows work in the configured environment:

1. A guest discovers restaurants serving a selected address.
2. The guest builds a multi-restaurant cart and signs in through phone verification without losing it.
3. Checkout calculates correct server-side totals and initiates payment.
4. Verified payment confirmation creates or confirms the correct child orders without duplication.
5. Each restaurant sees and manages only its own order.
6. An approved delivery partner accepts an assignment, collects the order, and completes delivery.
7. The consumer sees accurate order and delivery progress.
8. A partial rejection produces the correct customer experience and refund workflow.
9. Business email verification and administrator approval control restaurant activation.
10. Unauthorized access and invalid state transitions are rejected.
11. All implemented endpoints are documented.
12. The application starts from the documented setup without undocumented manual fixes.

Conclude with an honest implementation summary:

- What was built.
- What was tested and how.
- Which provider integrations were verified in demo, sandbox, or live mode.
- Which credentials or external approvals remain necessary.
- Known limitations and launch blockers.

Do not equate “code exists” with “the feature works.” Verify observable behavior wherever the environment allows.