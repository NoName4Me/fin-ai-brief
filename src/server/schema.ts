import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  integer,
  jsonb,
  date,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { BriefContent, Settings, Provenance } from './types.ts';
import type { Assessment } from './editorial.ts';
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const industries = pgTable('industries', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  sections: jsonb().$type<string[]>().notNull(),
  position: integer().notNull().default(0),
});
export const sources = pgTable('sources', {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  url: text(),
  format: text().notNull(),
  additionalUrls: jsonb('additional_urls').$type<string[]>().notNull().default([]),
  readDetails: boolean('read_details').notNull().default(false),
  originAddress: text('origin_address').notNull().default(''),
  sections: jsonb().$type<string[]>().notNull().default([]),
  catalogKey: text('catalog_key').unique(),
  sortOrder: integer('sort_order').notNull().default(1000000),
  priority: text().notNull().default('P1'),
  verificationStatus: text('verification_status').notNull().default('pending'),
  verificationNote: text('verification_note').notNull().default(''),
  verifiedAt: at('verified_at'),
  notes: text().notNull().default(''),
  intervalMinutes: integer('interval_minutes').notNull().default(60),
  autoInterval: boolean('auto_interval').notNull().default(false),
  minIntervalMinutes: integer('min_interval_minutes').notNull().default(60),
  maxIntervalMinutes: integer('max_interval_minutes').notNull().default(240),
  intervalReason: text('interval_reason'),
  quietRuns: integer('quiet_runs').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  stableRuns: integer('stable_runs').notNull().default(0),
  etag: text(),
  nextFetchAt: at('next_fetch_at'),
  industryId: text('industry_id')
    .notNull()
    .references(() => industries.id),
  enabled: boolean().notNull().default(false),
  lastFetchedAt: at('last_fetched_at'),
  lastError: text('last_error'),
  createdAt: at('created_at').defaultNow().notNull(),
});
export const articles = pgTable(
  'articles',
  {
    id: uuid().defaultRandom().primaryKey(),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceName: text('source_name').notNull(),
    industryId: text('industry_id')
      .notNull()
      .references(() => industries.id),
    url: text().notNull(),
    title: text().notNull(),
    excerpt: text().notNull(),
    publishedAt: at('published_at').notNull(),
    publishedPrecision: text('published_precision').notNull().default('time'),
    provenance: jsonb().$type<Provenance>(),
    state: text().notNull().default('pending'),
    eventId: uuid('event_id'),
    processingVersion: text('processing_version'),
    inputHash: text('input_hash'),
    facts: jsonb(),
    assessment: jsonb().$type<Assessment>(),
    scoreReason: text('score_reason'),
    reviewNote: text('review_note'),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('articles_url_unique').on(t.url)],
);
export const events = pgTable('events', {
  id: uuid().defaultRandom().primaryKey(),
  industryId: text('industry_id')
    .notNull()
    .references(() => industries.id),
  title: text().notNull(),
  summary: text().notNull(),
  section: text().notNull(),
  score: integer().notNull(),
  assessment: jsonb().$type<Assessment>(),
  tags: jsonb().$type<string[]>().notNull().default([]),
  occurredAt: at('occurred_at').notNull(),
  updatedAt: at('updated_at').defaultNow().notNull(),
});
export const briefs = pgTable(
  'briefs',
  {
    id: uuid().defaultRandom().primaryKey(),
    kind: text().notNull(),
    periodDate: date('period_date').notNull(),
    issueNumber: integer('issue_number'),
    autoMail: boolean('auto_mail').notNull().default(true),
    draft: jsonb().$type<BriefContent>(),
    published: jsonb().$type<BriefContent>(),
    generatedAt: at('generated_at'),
    publishedAt: at('published_at'),
  },
  (t) => [uniqueIndex('briefs_period_unique').on(t.kind, t.periodDate)],
);
export const subscriptions = pgTable('subscriptions', {
  id: uuid().defaultRandom().primaryKey(),
  email: text().notNull().unique(),
  kinds: jsonb().$type<string[]>().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  active: boolean().notNull().default(true),
  subscribedAt: at('subscribed_at').defaultNow().notNull(),
  unsubscribedAt: at('unsubscribed_at'),
  createdAt: at('created_at').defaultNow().notNull(),
});
export const subscriptionConfirmations = pgTable('subscription_confirmations', {
  email: text().primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  kinds: jsonb().$type<string[]>().notNull(),
  expiresAt: at('expires_at').notNull(),
  requestedAt: at('requested_at').defaultNow().notNull(),
  confirmedAt: at('confirmed_at'),
});
export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid().defaultRandom().primaryKey(),
    briefId: uuid('brief_id')
      .notNull()
      .references(() => briefs.id),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    state: text().notNull().default('pending'),
    error: text(),
    sentAt: at('sent_at'),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('deliveries_recipient_unique').on(t.briefId, t.subscriptionId)],
);
export const settings = pgTable('settings', {
  id: integer().primaryKey(),
  value: jsonb().$type<Settings>().notNull(),
});
export const sessions = pgTable('sessions', {
  hash: text().primaryKey(),
  expiresAt: at('expires_at').notNull(),
});
export const loginAttempts = pgTable('login_attempts', {
  key: text().primaryKey(),
  count: integer().notNull(),
  resetAt: at('reset_at').notNull(),
});
export const modelCalls = pgTable('model_calls', {
  id: uuid().defaultRandom().primaryKey(),
  purpose: text().notNull(),
  state: text().notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  apiAttempts: integer('api_attempts').notNull().default(0),
  error: text(),
  createdAt: at('created_at').defaultNow().notNull(),
});
