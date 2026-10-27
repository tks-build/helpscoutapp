# Guest Profile Panel — notes for Claude

This repo is the **Guest Profile Panel**: a Help Scout sidebar app used daily by about 35 booking managers (BMs) on Windows and macOS. It shows a guest's CRM record from Airtable next to their Help Scout conversation, and includes the lead form that replaced the old "HelpScout Extractor" Chrome extension.

- **Live:** `https://helpscoutapp-omega.vercel.app`. Help Scout loads it through an app's **Content URL**.
- **Stack:** Vite + React frontend (`src/`); Vercel serverless functions (`api/`); Airtable; Supabase (the Activity Log only); the Help Scout JavaScript SDK.
- **Current project:** the Activity Log. Read `ACTIVITY_LOG_HANDOVER.md` before working on it.

## Working rules (agreed with the project owner — follow them)

- **The panel is live.** Work on a branch and test on a Vercel preview. Nothing is merged to `main` or deployed to production without the owner's explicit approval.
- **Ask first.** Show the diff before any commit or push, and ask before pushing.
- **Secrets never go through chat.** Never ask for, print, log or commit keys, tokens, passwords, Zapier hook URLs or Stacker credentials. If a value is needed, say where to put it: Vercel → Environment Variables, Supabase, or a local `.env` (git-ignored).
- **Protected without approval:**
  - Airtable fields and tables;
  - Zapier Zaps and the data sent to them;
  - the Stacker CRM link format.
- **Never touch** the Help Scout profile fields "Guest Flag" and "Calendly": an automation sets them.
- **Test writes go to test data only:** a separate test Supabase project, and `LEAD_DRY_RUN=true` on Preview for the lead form.
- **Name the exact Vercel row when asking for a redeploy:** the commit message, the grey **Preview** badge, and the branch. The Production row jumps to the top after a redeploy and has been redeployed by mistake before.
- **Report honestly.** Verify before claiming something works, say plainly what was and wasn't tested, and keep reports short and in plain language, with open questions at the end.

## Commands

```bash
npm install
npm run dev        # Vite dev server; serves /api/airtable, /api/session, /api/enquiry and /api/lead locally (not /api/activity)
npm run build      # production build
node --test        # unit tests in test/
```

For local testing outside Help Scout, open the app with `?email=guest@example.com`, and optionally add `&conversationId=…&tag=trip-enquiry`.

## Where things live

| Path | What |
|---|---|
| `src/App.jsx` | The whole panel. Flags at the top: `ACTIVITY_WRITE_ENABLED`, `ACTIVITY_COPY_REPLY_ENABLED` and `PENDING_DETAILS_ENABLED` (all `false`). |
| `src/LeadForm.jsx` | The lead form (new or existing customer). Team contact and Status are required and never pre-filled; Trip starts empty. These were the owner's decisions; don't change them. |
| `src/api.js` | Browser-side helper: gets the Help Scout session, and `apiFetch` sends the token. |
| `api/airtable.js` | The guest lookup. `FIELDS` at the top is the field-name contract with Airtable. |
| `api/lead.js` + `lib/leadPayload.js` | The lead form's server side. The Zapier payload must stay byte-identical to the old extension's. Read the comments before touching it. |
| `api/enquiry.js` + `lib/enquiryForm.js` + `lib/mailboxApi.js` | Reads the website enquiry form from the email through the Help Scout Mailbox API. |
| `api/session.js` + `lib/session.js` | The Help Scout signature check (HMAC-SHA1 over `JSON.stringify` of the other query parameters, the "json" variant) and session tokens. |
| `api/activity.js` + `lib/supabaseAuth.js` + `db/schema.sql` | The Activity Log on Supabase. See the handover. |
| `api/mailvio.js` | Mailvio subscriptions. Never delete contacts; unsubscribe per group with `changeStatus`. |
| `api/sf-summary.js` | Daily cron that writes the "SF Good to know" summaries (`vercel.json`). |

## Gotchas

- **Settings:**
  - `HELPSCOUT_SECRET` must equal the Content signature key of the Help Scout app that loads production.
  - `HELPSCOUT_SECRET_TEST` is used on **preview deployments only**, for a test Help Scout app.
  - `REQUIRE_SESSION` is not set, so the older routes are still public. Only set it once every Help Scout app showing the panel has a matching key.
  - Settings only apply to deployments made after the change.
- **Supabase keys:**
  - Current secret keys (`sb_secret_…`) go in the `apikey` header only; as a Bearer token they're rejected as "Invalid JWT".
  - The publishable key gets "permission denied" by design. Never grant `anon` access.
  - New tables aren't exposed automatically, so grant `service_role` explicitly.
- **Airtable limits:** 5 API requests per second per base, shared by everything, and a record cap per base. Each panel load already makes several calls.
- **Help Scout apps:** only an app's creator can edit it. Check before planning changes to an app someone else made.
- **Vercel:** the account is on the free Hobby plan, so there are no team members. Deploys work for other contributors only while the repo is public.
- **Line endings:** some files use CRLF and some LF. Keep each file's existing line endings when editing.
