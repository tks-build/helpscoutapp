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

1. In Help Scout, go to Manage > Apps.
2. Create a new app.
3. Set the callback URL to the deployed app URL.
4. Add your secret key.
5. Enable the app for the mailboxes where the sales team works.

## Airtable lookup

The app looks up customers by email in the table configured by `TABLE_CUSTOMERS`.

By default it searches the Airtable field named `Email`. If your field is named differently, set:

```bash
AIRTABLE_CUSTOMERS_EMAIL_FIELD=Customer Email
```
