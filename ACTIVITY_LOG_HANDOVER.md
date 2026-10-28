# Activity Log — handover

**Status:** In progress, not live. Last updated 27 Oct 2026 by Kat (with Claude).
**For:** whoever takes over the Activity Log work from Kat.
**Repo:** `tks-build/helpscoutapp` (GitHub) · **Vercel project:** `helpscoutapp` · **Supabase project:** `guest-activity-log`

This document is meant to be complete. If something here is unclear or turns out to be wrong, fix the document as well as the code.

---

## 0. Update, 28 Oct 2026 (Courtney, with Claude)

Courtney has taken over. The big change: **the Activity Log now lives in TRTL**, not Supabase or Airtable.

- **TRTL has its own Activity Log**, live on `main` since 28 Oct 2026: an "Activity Log" tab on each guest profile.
  - Entries record the author, date and time, and the trip (or the lead's tags) they came from.
  - Authors can edit or delete their own entries; admins can change any.
  - Saving a Booking Note in TRTL logs it automatically, for everyone.
  - The tab is **admin-only for now**, while the Stacker import and testing happen.
  - Storage: one file per guest in TRTL's Vercel Blob store (`activity-log/<Customers record id>.json`). Not Airtable, so the record limits in §2 and §4 don't apply.
- **The panel posts to TRTL.** TRTL has a server-to-server endpoint, `/api/panel/activity` (GET and POST), protected by a shared key, `TRTL_PANEL_KEY`. On branch `activity-log-trtl`, `api/activity.js` forwards to it instead of Supabase (shared helper: `lib/trtl.js`). Deleting isn't offered from the panel; that's done in TRTL.
- **Booking notes saved in the panel are logged too**, as in TRTL. After the note saves to Airtable, `api/airtable.js` sends it to TRTL as a "Booking note" entry. TRTL adds the lead's or booking's trip (or tags) and a link to it.
  - Only a changed, non-empty note is logged. Checking this costs one extra Airtable read per save, made only while `TRTL_PANEL_KEY` is set.
  - A logging failure never fails the save.
  - `src/App.jsx` now sends the Help Scout user's name and email with each save, through a small React context (`HelpScoutUser`).
- **Supabase is expected to be retired.** It's empty and nothing will write to it once the branch is merged.
- **Courtney runs the Stacker history import** into TRTL; she has Stacker access.

**Update, 29 Oct 2026 (setup for testing the TRTL branch):**

- **Courtney is a collaborator** on `tks-build/helpscoutapp` and pushes `activity-log-trtl` herself. Vercel builds its preview automatically.
- **`main` is protected:** changes go in only through a pull request, with no force-pushes or deleting. The owner approves the merge.
- **The repo stays public** while Vercel is on Kat's free plan; otherwise Courtney's pushes won't deploy.
- **Settings in Vercel:**
  - `TRTL_PANEL_KEY`: **Preview only**, marked Sensitive. Production gets it at go-live.
  - `TABLE_BOOKING_CRM`: Production and Preview.
- **Test app:** Kat's **"GP test oct 09"** (Salt Caravan inbox). Its key already matches Preview (`HELPSCOUT_SECRET_TEST`). Kat sets its Content URL to the branch's preview address.

Answers to §3 are written under each question below.

---

## 1. The short version

- **What this is:** BMs (booking managers) record their activity on a guest (calls, emails, notes) in **Stacker's activity feed** today. Stacker is being replaced by **TRTL**, and the activity feed is one of the Stacker functions that needs a planned move.
- **What's built:** an Activity Log for the **Guest Profile Panel** (our Help Scout sidebar app):
  - a database table;
  - a server route that reads and writes it;
  - the panel section where BMs read and post entries.

  It is **switched off**, so BMs still use Stacker.
- **Where the data lives today:** a **Supabase** (hosted Postgres) project, set up and verified from a preview deployment on 27 Oct 2026. It is empty.
- **Where it should end up:** not decided yet; settling this is the first job (§3). If the answer turns out to be Airtable, §4 explains the limits that matter.
- **What's left:**
  1. Answer the questions in §3.
  2. Choose the storage option in §4.
  3. Fix one known issue (§9).
  4. Import Stacker's history (§10).
  5. Cut over (§11).

---

## 2. Background and decisions so far

**Why not Airtable from the start?** An activity feed only ever grows. Airtable caps the number of records **per base**, counted across every table: about 50,000 on Team, 125,000 on Business and 500,000 on Enterprise. It also allows only **5 API requests per second per base**, shared with the panel, the Zaps and every other integration. So the log was built on Postgres (Supabase) as the system of record.

**The decision that came later (Kat):** the log's final home should be **TRTL**, since TRTL won't sync with Airtable the way Stacker does. The Supabase table was therefore re-framed as a **bridge, not the destination**:
- it captures entries until TRTL is ready;
- it gives the panel somewhere to write today;
- moving it into TRTL later is a one-off copy.

Every row stores the guest's **email** as well as their Airtable record ID, so rows can be re-linked to TRTL guest IDs.

**Still open:** what TRTL is built on decides where the log lives. See §3 and §4.

**What the team was told** (Kat's earlier update to colleagues):
- getting a new log recording takes a few days;
- the Stacker history import depends on Stacker's API (an afternoon if clean, up to a week if not);
- the transition is **progressive**, not a hard cutover;
- at the switch, BMs must write in **one place only**, or notes get split across two systems.

---

## 3. Questions to answer first

Please answer these in this file, under each question, or send them to Kat.

### Where the log ends up

1. **What is TRTL built on?** Does it have its own database (Postgres, Supabase, something else), or is it a front end over the Airtable base? TRTL's header once read "Airtable · Leatherback Bookings", so I'm not sure.

2. **Where should the Activity Log live permanently?**
   - (a) inside TRTL's own database, owned by TRTL; or
   - (b) staying in this Supabase project, with TRTL reading and writing it.

   If TRTL's data is the Airtable base, read §4 before deciding.

   > **Answer (Q1–2, 28 Oct 2026):** TRTL is a Next.js app on Vercel over the Airtable base, with no database of its own. The Activity Log lives **in TRTL**, in its Vercel Blob store (one file per guest), owned by TRTL. Effectively option (a); not Airtable.

3. **If (a): when can TRTL accept entries, and how?** For example, direct database access, an API from TRTL, or a one-off import. If that's soon, we might send new entries straight to TRTL and use Supabase only for history.
   > *What "how" means:* the route a new note takes to reach TRTL's data.
   > 1. **Direct database access:** our server writes each note straight into the database TRTL reads. If that's Airtable, this means writing to an Airtable table.
   > 2. **An API from TRTL:** TRTL offers a "send me a note for guest X" address, and our panel posts to it. TRTL decides how and where it's stored.
   > 3. **A one-off import:** notes collect in Supabase until TRTL is ready, are copied across once, and go to TRTL from then on.

   > **Answer (28 Oct 2026):** now, through **an API from TRTL** (option 2): `POST`/`GET https://trtl.leatherbacktravel.com/api/panel/activity`, with `Authorization: Bearer <TRTL_PANEL_KEY>`. Stacker's history arrives by a one-off import that Courtney runs. TRTL skips entries it already has, so the import can be re-run.

### Volume (needed only if the answer is "Airtable")

These decide between options A and B in §4.

- **Which Airtable plan** is the base on, and **how many records does it hold now?** The base's usage page shows the record count.
- **Roughly how many entries are in Stacker's activity feed** since 2023? A ballpark is fine, e.g. "about 20 per guest" or a total from Stacker.
- **Does an "Activity Log" table already exist in the Airtable base?** An earlier version of the panel was built to write to one (see §6), so it may already be there.
- **How should TRTL show it:** all history, or recent entries only?

> **Answer (28 Oct 2026):** mostly no longer needed, as the log isn't going into Airtable. An "Activity Log" table does exist (`tblVYOGvQvPbDM3TX`: 8 fields, 4 records), plus "Testing - Leatherback Activity Feed" (3 records). Neither is used. TRTL shows all history, newest first, with search.

### Shape of the data

4. **How does TRTL identify a guest?** By the Airtable record ID (`rec…`), or by its own IDs? Is the guest's email reliable enough to match on?
5. **Are specific column names or types needed?** `db/schema.sql` shows the current design; adopt it as-is, or match TRTL's naming now.
6. **Will people also write notes inside TRTL** that need to appear in the same log, e.g. calls, emails or status changes?

   > **Answers (28 Oct 2026):**
   > - **Q4:** by the Airtable Customers record ID (`rec…`), the same ID the panel sends as `customerRef`. Email isn't used.
   > - **Q5:** TRTL's own shape is used. Its entries are `id`, `at`, `user`, `userEmail`, `kind` (`note` / `booking-note` / `imported`), `text`, `source`, `trips`, `tags`, `editedAt` and `editedBy`. The panel endpoint replies in the panel's existing shape (`id`, `type`, `body`, `author`, `occurredAt`).
   > - **Q6:** yes. Notes typed in TRTL (guest tab, leads, bookings, trip cards) and every Booking Note save land in the same log.

### Ownership and hosting

7. **Ownership and hosting.**
   - **(a) Who should own the Supabase project and the Vercel project long term:** a company account, or you?
   - **(b) Should the Supabase project stay in the US, or move to Australia?** Your call. Here's what we know.
     - **Where things are now:**
       - The Supabase project is in a US region, chosen to sit next to where Vercel runs the panel's server code.
       - **Airtable** is a US-hosted service: storing bases on its own US servers is how Airtable runs as standard, not a setting chosen in our projects. That covers the whole base, guest data included.
       - **Help Scout** is also US-hosted.
     - **Speed:** what matters is the distance between Vercel's servers and the database, not where the BMs are.
       - The panel's server code calls Airtable about six times every time a conversation opens, so it's best kept in the US, next to Airtable.
       - Moving **only** Supabase to Sydney would make every Activity Log request cross the Pacific.
       - Moving **both** Supabase and Vercel's server code to Sydney would make every Airtable call cross the Pacific instead, slowing the whole panel.
     - **Privacy and law:**
       - Australian privacy law generally allows personal data to be stored overseas with reasonable care.
       - The same guest data already sits in the US in Airtable and Help Scout, so moving only the Activity Log wouldn't change the company's overall position.
       - The one strong reason to move is a written promise, e.g. in the privacy policy or a partner contract, that data is stored in Australia. Worth a quick check; this isn't legal advice.
     - **Cost and effort:**
       - Same price either way.
       - A Supabase project's region can't be changed later, so moving means a new project and copying the data across. The table is empty now, so if it ever has to move, now is the cheapest time.
     - **It may not matter at all:** if the log ends up living in Airtable or TRTL (questions 1–3, §4), the Supabase location stops mattering.
     - **Claude's suggestion:** stay in the US unless a privacy promise requires Australia.
8. **When does Stacker's feed stop being used?** That sets the cutover deadline.

   > **Answers (28 Oct 2026):**
   > - **Q7a:** the Vercel project moves to a company Vercel account soon.
   > - **Q7b:** moot; Supabase is expected to be retired.
   > - **Q8:** to be decided later.

### For the handover itself (Courtney to fill in)

9. **Owners:** name the **primary owner** of this project and any **secondary owners**, with their roles.
10. **What access they'll get:** the Vercel project, the Supabase project, the GitHub repo (`tks-build/helpscoutapp`), Help Scout (apps and inbox settings), Stacker (for the history export), and possibly Airtable and Zapier.

    > **Answer (28 Oct 2026):** Courtney has Stacker access and runs the import. Other owners and access are still to be confirmed with Kat, alongside the Vercel move.

---

## 4. The storage decision

| Option | What it means | Right when |
|---|---|---|
| **A. Everything in Airtable** | The panel reads and writes an "Activity Log" table in the base, which TRTL shows natively. The Stacker history is imported into it. Supabase is retired. | History plus a few years of new entries fits comfortably within the plan's record limit (rule of thumb: under about a quarter of the remaining headroom), and the extra API traffic is acceptable. Simplest, and fully "inside TRTL". |
| **B. Supabase holds everything; Airtable holds recent entries for TRTL** | Supabase is the full record. The panel also writes each new entry to an Airtable table, and a scheduled job removes Airtable rows older than, say, 12 months. | The volume is too big for Airtable, but TRTL needs to show recent activity. More moving parts. |
| **C. Everything in Supabase; TRTL reads it there** | TRTL connects to Supabase directly. | TRTL gains a server or database integration of its own. Not realistic soon if TRTL only reads Airtable. |

What's built today is the Supabase half of **B** and **C**. Option **A** reuses some older code (§6) but needs new work: §12 lists it.

---

## 5. Current state (27 Oct 2026)

| Piece | State |
|---|---|
| Panel's Activity Log section | Built and **switched off**. BMs see only the "Activity log" title and an arrow linking to the guest's activity in Stacker. |
| Server route `/api/activity` | Built. Reads, adds and soft-deletes entries in Supabase. Live in production but unused: Production has no Supabase settings, so it returns 501 "not configured". |
| Supabase project `guest-activity-log` | Pro plan, Micro compute. Table created and locked down. **Empty.** |
| Branch `activity-log-supabase` | **Pushed, not merged.** Fixes how the Supabase key is sent (needed for current-style keys), adds the access grant to `db/schema.sql`, and adds tests. Safe to merge: nothing visible changes. |
| Preview of that branch | `https://helpscoutapp-git-activity-log-supabase-kat-1214s-projects.vercel.app`. A read of `/api/activity` returned `{"entries":[]}` on 27 Oct 2026, so the connection works. |
| Supabase settings in Vercel | Set on **Preview** only, and possibly pointing at the **real** project (see §8). Not set on Production. |
| Stacker history import | Not started. Needs the Stacker feed's API request (§10). |
| Known issue | Re-running an import would error on duplicates instead of merging them. Must be fixed before importing (§9). |

---

## 6. Where everything lives in the code

| File | What it does |
|---|---|
| `src/App.jsx` → `function ActivityLog` | The panel section. Switched by two flags near the top of the file: `ACTIVITY_WRITE_ENABLED` (the composer and feed) and `ACTIVITY_COPY_REPLY_ENABLED` ("Copy last reply" puts the BM's last sent Help Scout reply into the composer). Both are `false`. Loads entries only when the section is opened; posts with `customerRef` (Airtable record ID), `customerEmail`, `body`, `type: 'note'`, `authorName` and `authorEmail`. |
| `api/activity.js` | The route. `GET ?customerRef=…&email=…` returns up to 200 entries, newest first, matched on either ID. `POST` adds one; `DELETE ?id=…` soft-deletes (sets `deleted_at`). Talks to Supabase's REST API (PostgREST), with no database driver. |
| `lib/supabaseAuth.js` | How the key is sent. Current secret keys (`sb_secret_…`) go **only** in the `apikey` header; sent as `Authorization: Bearer`, Supabase rejects them with "Invalid JWT". Legacy `service_role` keys (JWTs) go in both. *(On the unmerged branch.)* |
| `db/schema.sql` | The table `activity_entries`: indexes, row-level security, and the grant for the server's role. Safe to re-run. |
| `api/helpscout.js` | Fetches the last sent reply for "Copy last reply" through the Help Scout Mailbox API. |
| `lib/session.js` | The Help Scout signature check and session tokens (see §8, `REQUIRE_SESSION`). |
| `api/airtable.js` → `createActivityEntry`, `shapeActivity`, `FIELDS.activity` | **Unused** older code that wrote to an **Airtable** "Activity Log" table (fields: Customer, Booking, Type, Body, Author, Source, Created). A `POST` with `recordType: 'activity'` now returns 410. This is the starting point if you choose option A. |
| `test/*.test.mjs` | Tests. Run with `node --test` from the project folder. `test/activity.test.mjs` checks the key headers and the route, with Supabase faked. |

### The table (`activity_entries`)

| Column | Meaning |
|---|---|
| `id` | uuid, generated |
| `customer_ref` | Airtable customer record ID today (`rec…`); a TRTL guest ID later |
| `customer_email` | Lower-case email: the durable way to re-link rows if IDs change |
| `booking_ref` | Optional booking record ID |
| `type` | `note`, `email`, `call`, `status_change` or `system` |
| `body` | The text (required, not blank) |
| `author_name`, `author_email` | Who wrote it |
| `source` | `helpscout`, `stacker_import`, `aircall`, `trtl` or `manual` |
| `source_ref` | ID in the originating system (e.g. a Stacker entry ID). Makes imports safe to re-run, once §9 is fixed |
| `occurred_at` | When it **happened**. Imported history must keep the original date, or it sorts to the top |
| `created_at` | When we stored it |
| `deleted_at` | Soft delete only. Rows are never removed |
| `metadata` | JSON extras (call length, recording link, thread ID…) |

Each row needs at least one of `customer_ref` or `customer_email`.

**Access:**
- Row-level security is on with no policies, so Supabase's public keys can't read or write the table. That was confirmed: a publishable key got "permission denied".
- The server's role is granted exactly `select`, `insert` and `update`, with no `delete`.
- New tables in this project are **not** exposed automatically. Grant any new table explicitly.

---

## 7. Accounts and access to transfer

Everything is currently under Kat. Agree with Kat which of these move to you, or to a company account (question 7).

| Thing | Where | Notes |
|---|---|---|
| **Which repo is real** | | **Vercel builds from `tks-build/helpscoutapp`.** That's the copy to work in. Kat mentioned a copy under the Leatherback GitHub account too. It isn't a fork of this repo and isn't linked to Vercel, so it won't receive changes made here; don't work in it unless Vercel is re-linked to it. To move the code under the company account, move this repo there and re-link Vercel (Settings → Git), ideally at the same time as the Vercel move below. |
| **GitHub repo** `tks-build/helpscoutapp` | Kat's personal GitHub | Kat adds you as a collaborator: repo **Settings → Collaborators → Add people**, then you accept the email invitation within 7 days. This doesn't change anything in Vercel or the panel's address. Moving the repo to an organisation instead means re-linking it in Vercel, and Vercel's free Hobby plan can't deploy private organisation repos. |
| **Vercel plan and repo visibility: read this before you push** | | Kat's Vercel account is on the free **Hobby** plan (scope `kat-1214s-projects`), which can't add you to the dashboard: changing settings or redeploying needs Kat until that changes. The repo is **public** (checked 27 Oct 2026; no secrets in its history), so your pushes **will** build previews. **If the repo is made private,** Hobby only deploys commits pushed by the account owner, so your pushes would be blocked, previews included. Either way, the fix is (1) upgrading Kat's account to **Pro** and inviting you (Settings → Members), which keeps the address, or (2) transferring the project to a company **Pro** team you belong to (see the next row). Use the same email for your Git commits as for your Vercel account; Vercel matches commits by email. Whether the repo should stay public is for Kat to decide. |
| **Vercel project** `helpscoutapp` | Kat's Vercel account | Transfer it (project Settings → look for **Transfer Project**) or add you to the team. **After any transfer, check the production address `https://helpscoutapp-omega.vercel.app` still works.** If it changes, every Help Scout app pointing at it must be updated (Help Scout → Workspace → Apps → the app → Content URL), or the panel disappears for all BMs. Settings move with the project, but secret values can't be read back: re-enter any you need to change. A private repo owned by a GitHub **organisation** can only deploy on Vercel **Pro**. |
| **Supabase project** `guest-activity-log` | Supabase (Pro plan) | Invite you to the organisation (Organization → Team), or transfer the project (Project Settings → General → Transfer project). Billing follows the organisation. |
| **Help Scout apps** | Workspace → Apps | In Kat's experience, only the **creator** of a custom app can edit it: the original "Guest Profile Panel" app's settings were greyed out for her. Create **your own** test app (§8), and expect to need Kat for apps she created. |
| **Stacker** | | Needed to capture the activity feed's API request (§10). |
| **Airtable** | base `appnRSV0g89whVidp` | Needed for option A or B. |

**Never paste keys, tokens, Zapier hook addresses or passwords into chat, Slack, tickets or this file.** They live in Vercel's settings, Supabase, and your password manager.

---

## 8. Settings (Vercel → `helpscoutapp` → Settings → Environment Variables)

| Name | Environment | Value comes from | State |
|---|---|---|---|
| `SUPABASE_URL` | Preview (Production at cutover) | Supabase → Project Settings → **Data API** → Project URL. Exactly `https://<code>.supabase.co`, **with nothing after `.co`**: the code adds `/rest/v1` itself. Type **Config**, so you can read it back. | Set on Preview |
| `SUPABASE_SERVICE_ROLE_KEY` | Preview (Production at cutover) | Supabase → Project Settings → **API Keys** → **Secret keys** (starts `sb_secret_`). **Not** the publishable key (`sb_publishable_…`), which gets "permission denied". Type **Secret**. | Set on Preview |
| `HELPSCOUT_APP_ID`, `HELPSCOUT_APP_SECRET` | Production + Preview | Help Scout → Profile → **My Apps** (an OAuth2 app). Used by "Copy last reply" and the lead form's enquiry reading. | Set |
| `HELPSCOUT_SECRET` | Production (check whether Preview is also ticked; previews use `HELPSCOUT_SECRET_TEST` when that is set) | The **Content signature key** of the Help Scout app that loads the panel in production. | Set |
| `HELPSCOUT_SECRET_TEST` | Preview only | The Content signature key of **your** Help Scout test app. Used only on preview deployments (`VERCEL_ENV === 'preview'`); production ignores it. | Set (Kat's test app) |
| `REQUIRE_SESSION` | Production, later | `true` makes every `/api` route require a Help Scout session. **Not set**, so the older routes, including `/api/activity`, still answer anyone who knows the address. | Not set; see §13 |
| `LEAD_DRY_RUN` | Preview only | `true` stops the **lead form** (not the Activity Log) from sending to Zapier on previews. Never on Production. | Set on Preview |

**Preview vs the real data:** Supabase's Preview settings may currently point at the **real** `guest-activity-log` project. Before any write test, check the value of `SUPABASE_URL` on Preview against the real project's URL. If they match, create a separate **test** Supabase project and switch Preview to it, so test entries never land in the real log:
1. Use a Free organisation to avoid about $10 a month of compute.
2. Run `db/schema.sql` in its SQL Editor.

**Your Help Scout test app (to test the panel itself):**
1. Workspace → Apps → **Create**.
2. **Content URL:** the preview address of the branch you're testing.
3. **Content signature key:** a new random key, 40 characters or fewer.
4. Enable it on **one** inbox.
5. Put the same key in `HELPSCOUT_SECRET_TEST` (Preview).

**Changing settings:** Vercel only applies them to deployments made **after** the change. Redeploy afterwards: Deployments → the row with the grey **Preview** badge for your branch → ⋯ → **Redeploy**. Kat redeployed the **Production** row by mistake more than once, because the newest deployment jumps to the top of the list. Check the badge, or filter the list by Environment.

---

## 9. Known issue to fix before importing

**Problem:** re-running an import should update existing rows. Today it errors instead:
- `api/activity.js` saves with `Prefer: resolution=merge-duplicates` but no conflict target, so Supabase matches on the primary key (`id`), which is new every time.
- The uniqueness rule on `(source, source_ref)` is a **partial** index. PostgREST can't use a partial index as a conflict target, so a repeated `source_ref` fails with a duplicate-key error rather than merging.

Hand-written notes aren't affected (they have no `source_ref`), but an import is.

**Fix (in the Supabase SQL Editor, test project first):**
```sql
drop index if exists activity_source_ref_idx;
alter table activity_entries
  add constraint activity_source_ref_unique unique (source, source_ref);
```
A normal unique constraint still allows many rows with an empty `source_ref`, because Postgres treats empty values as distinct.

**And in code:** have imports post to `/activity_entries?on_conflict=source,source_ref` with `Prefer: resolution=merge-duplicates`, then update `db/schema.sql` to match. Add a test. Under option A, the same idea applies: look up by Source Ref before creating.

---

## 10. Importing Stacker's history (2023 → now)

1. **Capture Stacker's API request.**
   1. In Stacker, open a guest and open the browser's DevTools → **Network**.
   2. Reload the activity feed and find the request that returns the entries.
   3. Right-click it → **Copy as cURL**.

   The copied request contains Stacker login credentials, so treat it like a password: keep it out of the repo and out of chat.
2. **Learn the response:**
   - the entry ID (becomes `source_ref`);
   - the **original date** (becomes `occurred_at`; this matters most);
   - the author, the body text, and the guest ID. Stacker's customer pages use `cus_` + the Airtable record ID, so `customer_ref` should be the `rec…` part.
   - Also check how the feed pages through results and whether it limits request rates.
3. **Write a one-off import script** (Node, run locally, not deployed). It reads Stacker's feed for every guest and writes rows with `source = 'stacker_import'`. Only run it after §9 is fixed.
4. **Rehearse on the test project.** Compare counts for a few guests against Stacker, and check the dates and authors look right.
5. **Run it on the real project.** At cutover, run it again as a top-up to catch anything written in between. Re-running is safe once §9 is fixed.

Under option A, the script writes to the Airtable table instead, and must stay under 5 requests per second (batch up to 10 records per create call).

---

## 11. Cutover (whatever the storage option)

1. **Merge** `activity-log-supabase` into `main` (your approval). Nothing visible changes.
2. **Production settings:** add the **real** project's `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on **Production** (option B or C), or the Airtable table settings (option A). Then redeploy Production. Still nothing visible.
3. **History in:** run the import (§10) on the real data, then spot-check.
4. **Switch on:** set `ACTIVITY_WRITE_ENABLED = true` in `src/App.jsx` (and, if wanted, `ACTIVITY_COPY_REPLY_ENABLED`) on a branch, test it on a preview with your test app, then merge with approval.
5. **Tell the team:** from today, write activity notes in the panel, not in Stacker.
6. **Top-up import** of anything written in Stacker since step 3.
7. **Make Stacker's feed read-only**, or tell people to stop using it, by the date from question 8.

**Rollback at any point:**
- **Code:** Vercel → Deployments → the previous Production deployment → ⋯ → **Promote to Production**. This is instant.
- **Panel section:** set the flag back to `false`. The data stays where it is.

---

## 12. Extra work if you choose option A (Airtable) or B (hybrid)

- **Airtable table** "Activity Log":
  - Customer (link to Customers), Booking (link to Bookings), Type (single select), Body (long text);
  - Author, Author Email, Source (single select), Source Ref (text);
  - Occurred At (date and time), Created (created time).

  Check whether it already exists (§3). Adding a table and fields is a change to the live Airtable base, so agree it with Kat first.
- **Route:** change `api/activity.js` to read and write that table, starting from the old `createActivityEntry` / `shapeActivity` code in `api/airtable.js`. Use the Airtable library already in the project. Keep the same request and response shape, so the panel doesn't need changes. Add `TABLE_ACTIVITY_LOG` to Vercel.
- **Rate limits:** each panel load already makes several Airtable calls. Keep the activity read to one query (filter by the customer's record), and cache where sensible.
- **Option B only:** the panel writes to Supabase first, then Airtable. Add a daily job (`vercel.json` crons, like the existing `/api/sf-summary`) that removes Airtable rows older than the chosen window.

---

## 13. Rules for working on the panel

These were agreed with Kat. The panel is live and used daily by about 35 people on Windows and macOS.

- **Branch and preview first.** Push your branch; Vercel builds a preview. `main` is protected: changes go in only through a pull request that the owner approves, with no force-pushes or deleting.
- **Don't change without approval:**
  - Airtable fields or tables;
  - Zapier Zaps or the data sent to them;
  - the Stacker link format.
- **Never touch the Help Scout profile fields "Guest Flag" and "Calendly"**: an automation sets them.
- **Never print, log or commit secrets.**
- **Test-write only to test data:** use a test Supabase project, or the lead form's `LEAD_DRY_RUN`.
- **`REQUIRE_SESSION=true`:** turn it on only once every Help Scout app showing the panel has a key that matches `HELPSCOUT_SECRET`. Any app with a non-matching key then loses the **whole** panel, not just the form. When it's on, `/api/activity` also stops answering the public, which is the goal.

---

## 14. Quick checks you can run

From any terminal, against the branch preview. These work while `REQUIRE_SESSION` isn't set on Preview.

**Read (safe: a made-up guest, so it can only return an empty list):**
```bash
curl "https://helpscoutapp-git-activity-log-supabase-kat-1214s-projects.vercel.app/api/activity?customerRef=recZZZZZZZZZZZZZZ&email=readcheck%40example.invalid"
```
Expected: `{"entries":[]}`.

| Reply | Meaning |
|---|---|
| `Failed to parse URL from SUPABASE_URL…` | The `SUPABASE_URL` value is wrong (it once held its own name). |
| `permission denied … TO anon` | The publishable key was used instead of the secret key. **Don't** follow Supabase's hint to grant access to `anon`. |
| `Invalid JWT` | The key is being sent the old way; check the branch with `lib/supabaseAuth.js` is the one deployed. |
| 501 "not configured" | The settings aren't on this deployment. Redeploy the right Preview row. |

**Write, read back, remove — test project only:** `POST` a JSON body with `customerRef`, `customerEmail`, `body` and `authorName` to `/api/activity`; `GET` it back; then `DELETE /api/activity?id=<id>` (a soft delete).

**Unit tests:** run `node --test` in the project folder. 23 tests should pass.

---

## 15. Glossary

- **BM:** booking manager, the panel's main users.
- **Guest Profile Panel:** the Help Scout sidebar app in this repo, live at `https://helpscoutapp-omega.vercel.app`.
- **Stacker:** the current CRM front end over Airtable, being replaced by **TRTL**, the new CRM.
- **Preview:** a Vercel deployment of a branch, with its own address, separate from production.
- **Supabase:** hosted Postgres. **PostgREST:** the REST API Supabase puts in front of it.
- **Zap:** a Zapier automation. The panel's lead form posts to two of them; the Activity Log doesn't.

**Who to ask:** Kat (history of this work, Help Scout apps she created, approvals and decisions, company accounts).

---

## 16. Working on this with Claude

`CLAUDE.md` in this repo holds the working rules and the project quirks. Claude Code reads it automatically, so the rules don't need pasting in.

**Setup:** use the Claude desktop app's **Code** tab, opened on a local copy of the repo:
```bash
git clone https://github.com/tks-build/helpscoutapp.git
cd helpscoutapp
git checkout activity-log-supabase
```
If you use an ordinary Claude chat or Project instead, upload this file, `CLAUDE.md`, `db/schema.sql`, `api/activity.js`, `lib/supabaseAuth.js` and `src/App.jsx`. In that case, also paste the rules from `CLAUDE.md` into your first message, because only Claude Code reads it automatically.

**First message:**
```text
I'm taking over the Activity Log project in this repo. Read ACTIVITY_LOG_HANDOVER.md and CLAUDE.md in full, then look at the files they point to. Follow the working rules in CLAUDE.md.

Don't write any code yet. Give me (1) a plain-language summary of where things stand, (2) the questions in section 3 I still need to answer, and (3) anything in the handover that looks wrong or out of date compared with the code.
```

**One prompt per stage:**
- **After answering §3:** "Here are my answers to section 3: [paste]. Recommend a storage option from section 4 (A, B or C) with reasons, list exactly what work it involves, and wait for my approval before starting."
- **The fix before importing (§9):** "Implement the section 9 fix on a new branch from activity-log-supabase: the SQL change, the code change and a test. Give me the SQL to run in the TEST Supabase project first. Show me the diff before pushing."
- **Looking at Stacker's data safely (§10):** "I've saved Stacker's feed request (Copy as cURL) to a local file that git ignores. Write a small script that reads it, fetches ONE guest's feed, and prints only the field names and one anonymised example. Don't print or store the credentials."
- **The import (§10):** "Write the one-off Stacker import script described in section 10. It must be safe to re-run and keep the original dates. Rehearse it against the test project, then report counts for 3 guests compared with Stacker."
- **Cutover (§11):** "Walk me through section 11 one step at a time. Stop after each step and wait for me to confirm before the next."
