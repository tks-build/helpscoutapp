# Help Scout Airtable Sidebar App

This project is set up for Help Scout's newer App Developer Platform. The sidebar app runs as a Vite React app inside Help Scout's iframe and calls a server-side Vercel API route to search Airtable.

## Local setup

1. Install Node.js, which includes npm.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the Vercel local server:

   ```bash
   npm run dev
   ```

For Help Scout testing, the callback URL must be network reachable and use HTTPS. A deployed Vercel URL is the cleanest option.

## Help Scout setup

1. In Help Scout, go to **Workspace → Apps** in the left sidebar (not **My Apps** under your profile, which only issues API credentials).
2. Click **Create**.
3. Set the callback URL to the deployed app URL.
4. Add your secret key.
5. Enable the app for the mailboxes where the sales team works.

## Lead form

The panel includes the form from the old HelpScout Extractor extension: add a new customer, or update one and add a lead. It appears in place of "no match" for unknown guests, and under **Add lead / update details** for known ones.

- Guest details come from the Help Scout app payload. For website enquiries, the telephone, trip and message are read from the form in the email through the Mailbox API (`/api/enquiry`).
- The lookup covers the profile's email addresses and the one typed into the enquiry form.
- Submitting posts to the same two Zapier catch hooks the extension used, with the same body (`lib/leadPayload.js`). Nothing writes to Airtable or Help Scout directly.
- The form and the enquiry lookup need a session: Help Scout signs the panel's URL with the app's secret key, and `/api/session` checks it against `HELPSCOUT_SECRET`.

Settings are listed in `.env.example`. Preview deployments use the live Zaps, so set `LEAD_DRY_RUN=true` on Preview to see what would be sent without sending it.

## Airtable lookup

The app looks up customers by email in the table configured by `TABLE_CUSTOMERS`.

By default it searches the Airtable field named `Email`. If your field is named differently, set:

```bash
AIRTABLE_CUSTOMERS_EMAIL_FIELD=Customer Email
```
