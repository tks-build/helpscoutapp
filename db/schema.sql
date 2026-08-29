-- Activity feed — system of record.
--
-- Deliberately independent of Airtable. An activity feed is append-only and
-- unbounded, which is the one workload Airtable is poorly suited to: records
-- are capped per base (cumulative across every table), and the API is limited
-- to 5 requests per second per base at every pricing tier.
--
-- Airtable will hold a rolling display cache for Stacker. This table is the
-- truth, and TRTL reads it directly when it arrives.

create extension if not exists "pgcrypto";

create table if not exists activity_entries (
    id uuid primary key default gen_random_uuid(),

    -- Dual identity, deliberately.
    --
    -- customer_ref holds the Airtable record id today and a TRTL guest id
    -- later. customer_email is the durable fallback: if we key only on
    -- Airtable ids and then leave Airtable, every row here is orphaned.
    customer_ref     text,
    customer_email   text,

    booking_ref      text,

    -- note | email | call | status_change | system
    type             text        not null default 'note',
    body             text        not null,

    author_name      text,
    author_email     text,

    -- helpscout | stacker_import | aircall | trtl | manual
    source           text        not null,
    -- Identifier in the originating system: a Help Scout thread id, an Aircall
    -- call id, a Stacker entry id. Makes imports safe to re-run.
    source_ref       text,

    -- When the thing happened, versus when we recorded it. A Stacker entry
    -- scraped from 2023 was created today but occurred two years ago; without
    -- both, imported history sorts to the top and the feed is useless.
    occurred_at      timestamptz not null default now(),
    created_at       timestamptz not null default now(),

    -- Soft delete only. An activity log you can destroy rows in is not a
    -- record of anything.
    deleted_at       timestamptz,

    -- Source-specific extras — call duration, recording url, thread id.
    metadata         jsonb       not null default '{}'::jsonb,

    constraint activity_body_not_blank check (length(btrim(body)) > 0),
    constraint activity_has_identity check (
        customer_ref is not null or customer_email is not null
    )
);

-- Primary read path: one customer's feed, newest first.
create index if not exists activity_customer_ref_idx
    on activity_entries (customer_ref, occurred_at desc)
    where deleted_at is null;

-- Fallback read path once customer_ref changes meaning under TRTL.
create index if not exists activity_customer_email_idx
    on activity_entries (lower(customer_email), occurred_at desc)
    where deleted_at is null;

-- Idempotency. Re-running the Stacker scraper or replaying Aircall webhooks
-- updates rows rather than duplicating the feed. Partial, so entries without
-- a source_ref (hand-written notes) are unaffected.
create unique index if not exists activity_source_ref_idx
    on activity_entries (source, source_ref)
    where source_ref is not null;

-- Only the service role touches this table. The panel reaches it through a
-- server route; no key ever goes to the browser.
alter table activity_entries enable row level security;
