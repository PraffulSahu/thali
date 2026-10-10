/**
 * Static public pages rendered inside <PublicShell>: /terms, /privacy, /refunds, /help (plain-language pilot
 * copy) and the marketing pages /partner-with-us, /ride-with-thali (CTA → sign-in with the right role tab).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { roleEntryHref } from '../../components/layout/PublicShell';
import { ButtonLink } from '../../components/ui/Button';
import { Icon, type IconName } from '../../components/ui/Icon';
import { useDocumentTitle } from '../../components/ui/PageHeader';
import { Eyebrow } from '../../components/ui/Typography';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';

function StaticPage({ eyebrow, title, lead, updated, children }: { eyebrow: string; title: ReactNode; lead?: ReactNode; updated?: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-[820px] px-6 pb-20 pt-14 max-sm:px-4 max-sm:pt-10">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="mt-3 text-[clamp(34px,4vw,48px)] leading-[1.02]">{title}</h1>
      {lead ? <p className="mt-4 text-[17px] leading-[1.6] text-fg-3">{lead}</p> : null}
      {updated ? <p className="mt-3 font-mono text-xs uppercase tracking-[.06em] text-fg-3">Last updated {updated}</p> : null}
      <div className="mt-10 flex flex-col gap-8">{children}</div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[22px] leading-tight">{title}</h2>
      <div className="flex flex-col gap-3 text-[15.5px] leading-[1.65] text-fg-2 [&_a]:font-semibold [&_a]:text-acc-fg [&_a:hover]:underline [&_li]:ml-5 [&_li]:list-disc">
        {children}
      </div>
    </section>
  );
}

function PilotNote() {
  return (
    <p className="flex items-start gap-2.5 rounded-field border border-line bg-warn-bg px-4 py-3.5 text-sm text-fg-2">
      <Icon name="info" size={16} className="mt-0.5 shrink-0 text-warn" />
      Thali is a Bengaluru pilot. In demo mode no real money moves, no SMS is sent and deliveries are simulated — the banner at the top of the
      app tells you which mode you are in.
    </p>
  );
}

export function TermsPage() {
  useDocumentTitle('Terms');
  return (
    <StaticPage eyebrow="Legal" title="Terms of use" lead="A plain-language summary of how ordering on Thali works during the pilot." updated="11 Oct 2026">
      <PilotNote />
      <Section title="Who we are">
        <p>Thali is a marketplace: restaurants sell and prepare food, independent delivery partners deliver it, and Thali runs the app, the checkout and support.</p>
      </Section>
      <Section title="Orders and payment">
        <p>One checkout can include several restaurants. You pay once; each restaurant becomes its own order with its own status, delivery partner and delivery code.</p>
        <p>Prices, fees and taxes are shown per restaurant before you pay. The total is the sum of those amounts — there are no hidden charges added after payment.</p>
      </Section>
      <Section title="If a restaurant can’t fulfil your order">
        <p>If a restaurant declines or can’t prepare your order, only that restaurant’s share is refunded; the rest of your order carries on. See <Link to="/refunds">Refunds</Link>.</p>
      </Section>
      <Section title="Estimates and ratings">
        <p>Delivery times are estimates and are labelled as such. Ratings appear only once a restaurant has at least five of them.</p>
      </Section>
      <Section title="Your account">
        <p>You sign in with a one-time code sent to your mobile number. Keep access to your phone; you are responsible for orders placed from your account.</p>
      </Section>
      <Section title="Contact">
        <p>
          Questions about these terms? Raise a ticket from <Link to="/help">Help &amp; support</Link>.
        </p>
      </Section>
    </StaticPage>
  );
}

export function PrivacyPage() {
  useDocumentTitle('Privacy');
  return (
    <StaticPage eyebrow="Legal" title="Privacy policy" lead="What we collect, why, and who sees it." updated="11 Oct 2026">
      <PilotNote />
      <Section title="What we collect">
        <ul>
          <li>Your mobile number (to sign you in) and, if you add them, your name, email and saved addresses.</li>
          <li>Your orders, payments and refunds, so we can show your history and settle with restaurants.</li>
          <li>Your delivery location when you choose one. We only use your device location when you tap “Use my location”.</li>
        </ul>
      </Section>
      <Section title="Who sees what">
        <ul>
          <li>Restaurants see your first name and the items you ordered from them.</li>
          <li>Delivery partners see the pickup area when offered a delivery, and your drop address and a way to contact you only after they accept.</li>
          <li>Thali operations staff see what they need to resolve orders and support tickets; their actions are audited.</li>
        </ul>
      </Section>
      <Section title="Partner location">
        <p>Delivery partners share their location only while they are online, so customers can track deliveries.</p>
      </Section>
      <Section title="Your choices">
        <p>
          You can edit or delete saved addresses, sign out of all devices from your account, and ask for your data to be deleted through{' '}
          <Link to="/help">support</Link>.
        </p>
      </Section>
    </StaticPage>
  );
}

export function RefundsPage() {
  useDocumentTitle('Refunds');
  return (
    <StaticPage eyebrow="Help" title="Refunds, to the rupee" lead="Every restaurant in your order is refunded on its own, and we always show paid, refunded and pending amounts separately.">
      <Section title="When you get a refund">
        <ul>
          <li>A restaurant declines your order, or doesn’t accept it in time.</li>
          <li>A delivery fails and the order can’t be completed.</li>
          <li>Support approves a refund for a problem with your order.</li>
        </ul>
      </Section>
      <Section title="How much">
        <p>
          You get back that restaurant’s full share: its items, its share of any coupon or membership discount, its delivery and packaging fees and the
          taxes on them. Other restaurants in the same checkout are not affected.
        </p>
      </Section>
      <Section title="How long it takes">
        <p>
          Refunds go back to the original payment method. Your order page shows each refund as <strong>initiated</strong>, <strong>processing</strong> or{' '}
          <strong>refunded</strong>, with the amount — we never show a refund as done before the payment provider confirms it.
        </p>
      </Section>
      <Section title="Something wrong?">
        <p>
          Open the order and tap <strong>Get help</strong>, or raise a ticket from <Link to="/help">Help &amp; support</Link>.
        </p>
      </Section>
    </StaticPage>
  );
}

const HELP_TOPICS: Array<{ icon: IconName; title: string; body: string; to: string; cta: string }> = [
  { icon: 'receipt', title: 'An order', body: 'Track it, see each restaurant’s status, or report a problem.', to: '/orders', cta: 'Your orders' },
  { icon: 'wallet', title: 'Refunds', body: 'How partial refunds work and how long they take.', to: '/refunds', cta: 'Read about refunds' },
  { icon: 'ticket', title: 'Talk to us', body: 'Raise a support ticket; we reply in the app.', to: '/support', cta: 'Open support' },
];

export function HelpPage() {
  useDocumentTitle('Help & support');
  return (
    <StaticPage eyebrow="Help & support" title="How can we help?" lead="Most answers are on your order page. For anything else, raise a ticket — you’ll need to sign in so we can see your orders.">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3">
        {HELP_TOPICS.map((t) => (
          <Link key={t.title} to={t.to} className="group flex flex-col gap-2 rounded-card-lg border border-line bg-card p-5 hover:border-line-2 hover:shadow-card">
            <span className="grid size-10 place-items-center rounded-item bg-acc-soft text-acc-fg">
              <Icon name={t.icon} size={20} />
            </span>
            <h2 className="text-lg">{t.title}</h2>
            <p className="text-sm text-fg-3">{t.body}</p>
            <span className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-extrabold text-acc-fg">
              {t.cta} <Icon name="arrow-right" size={14} className="transition-transform group-hover:translate-x-1" />
            </span>
          </Link>
        ))}
      </div>
      <Section title="Common questions">
        <p>
          <strong>Can I order from two restaurants at once?</strong> Yes — add from any restaurants that deliver to you; you pay once and each one
          delivers separately.
        </p>
        <p>
          <strong>Why does a restaurant show “New” instead of stars?</strong> We only show a rating after five customers have rated it.
        </p>
        <p>
          <strong>What is the delivery code?</strong> A 4-digit code on your order page. Tell it to the delivery partner at the door so we know the
          order reached you.
        </p>
      </Section>
      <Section title="For restaurants and partners">
        <p>
          Restaurant owners and delivery partners can reach support from their console. New here? See <Link to="/partner-with-us">Partner with us</Link>{' '}
          or <Link to="/ride-with-thali">Ride with Thali</Link>.
        </p>
      </Section>
    </StaticPage>
  );
}

function Feature({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-card-lg border border-line bg-card p-6">
      <span className="grid size-11 place-items-center rounded-control bg-acc-soft text-acc-fg">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="text-lg leading-tight">{title}</h3>
      <p className="text-[14.5px] leading-normal text-fg-3">{body}</p>
    </div>
  );
}

function MarketingPage({
  eyebrow, title, accent, lead, tone, features, steps, primary, secondary,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  lead: string;
  tone: 'chili' | 'ink';
  features: Array<{ icon: IconName; title: string; body: string }>;
  steps: string[];
  primary: { to: string; label: string };
  secondary: { to: string; label: string };
}) {
  return (
    <div className="pb-20">
      <section className="mx-auto w-full max-w-[1240px] px-6 pt-12 max-sm:px-4 max-sm:pt-8">
        <div className={cn('on-color relative flex flex-col gap-5 overflow-hidden rounded-block p-12 text-white max-sm:p-7', tone === 'chili' ? 'bg-[#d23f11]' : 'bg-[#141414]')}>
          <p className={cn('eyebrow', tone === 'chili' ? 'text-[#ffd7c7]!' : 'text-[#ffc145]!')}>{eyebrow}</p>
          <h1 className="max-w-[40rem] text-[clamp(34px,4.4vw,56px)] leading-[1.02]">
            {title} <span className={tone === 'chili' ? 'text-[#ffd7c7]' : 'text-[#ffc145]'}>{accent}</span>
          </h1>
          <p className={cn('max-w-[36rem] text-[17px] leading-[1.6]', tone === 'chili' ? 'text-[#ffe6dc]' : 'text-[#c9c9c9]')}>{lead}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <ButtonLink to={primary.to} variant={tone === 'chili' ? 'on-chili' : 'on-ink'} size="lg">
              {primary.label}
            </ButtonLink>
            <ButtonLink to={secondary.to} variant={tone === 'chili' ? 'on-chili-outline' : 'on-ink-outline'} size="lg">
              {secondary.label}
            </ButtonLink>
          </div>
        </div>
      </section>
      <section aria-label="Why Thali" className="mx-auto mt-12 grid w-full max-w-[1240px] grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-4 px-6 max-sm:px-4">
        {features.map((f) => (
          <Feature key={f.title} {...f} />
        ))}
      </section>
      <section aria-labelledby="steps-title" className="mx-auto mt-14 w-full max-w-[1240px] px-6 max-sm:px-4">
        <h2 id="steps-title" className="text-[clamp(28px,3.2vw,38px)] leading-tight">
          How to get started
        </h2>
        <ol className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3">
          {steps.map((s, i) => (
            <li key={s} className="flex items-start gap-3 rounded-card border border-line bg-card p-5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-acc-soft font-mono text-sm font-medium text-acc-fg">{i + 1}</span>
              <span className="pt-1 text-[15px] text-fg-2">{s}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function PartnerWithUsPage() {
  useDocumentTitle('Partner with us');
  const auth = useAuth();
  return (
    <MarketingPage
      eyebrow="For restaurants"
      title="A counter screen built for"
      accent="rush hour."
      lead="New orders chime in with a countdown. Accept with a prep time in one tap, mark ready, hand over with a pickup code. Earnings and payouts in the same place."
      tone="chili"
      features={[
        { icon: 'bell', title: 'Live orders', body: 'Chime and countdown on every new order. Accept with a prep time, or reject with a reason.' },
        { icon: 'list', title: 'Menu and stock', body: 'Toggle availability in one tap. Stock can’t go below what’s already reserved in carts.' },
        { icon: 'wallet', title: 'Earnings and payouts', body: 'Every payout marked Paid carries its bank UTR. Refunds and commission are itemised.' },
      ]}
      steps={['Sign in with your mobile number', 'Add your restaurant details, hours and documents', 'Verify your business email', 'Build your menu and go live after approval']}
      primary={{ to: roleEntryHref('restaurant', auth.isAuthenticated), label: 'List your restaurant' }}
      secondary={{ to: '/signin?role=restaurant', label: 'Restaurant sign in' }}
    />
  );
}

export function RideWithThaliPage() {
  useDocumentTitle('Ride with Thali');
  const auth = useAuth();
  return (
    <MarketingPage
      eyebrow="For delivery partners"
      title="Clear offers."
      accent="Honest earnings."
      lead="See distance, time and why a second order fits your route before you accept. Codes at pickup and drop keep every handover clean."
      tone="ink"
      features={[
        { icon: 'navigation', title: 'Go online in one tap', body: 'Your location is shared only while you’re online.' },
        { icon: 'bike', title: 'Offers you can judge', body: 'Distance, time and why a second order fits — before you accept. Carry up to two at once.' },
        { icon: 'shield-check', title: 'Codes at each handover', body: 'Pickup code at the restaurant, delivery code at the door. Earnings tracked per delivery.' },
      ]}
      steps={['Sign in with your mobile number', 'Add your profile and vehicle', 'Upload ID, licence and RC', 'Go online once approved']}
      primary={{ to: roleEntryHref('partner', auth.isAuthenticated), label: 'Apply to ride' }}
      secondary={{ to: '/signin?role=partner', label: 'Partner sign in' }}
    />
  );
}
