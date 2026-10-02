import react from '@vitejs/plugin-react';
import 'dotenv/config';
import { defineConfig } from 'vite';
import airtableHandler from './api/airtable.js';
import enquiryHandler from './api/enquiry.js';
import leadHandler from './api/lead.js';
import sessionHandler from './api/session.js';

// Adapts a Vercel-style handler to the Vite dev server, so `npm run dev`
// serves the API routes alongside the app. On Vercel the files in api/ are
// the routes and none of this runs.
function mountApi(server, path, handler) {
  server.middlewares.use(path, async (req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    req.query = Object.fromEntries(url.searchParams.entries());
    req.method = req.method || 'GET';

    if (req.method === 'POST' && req.body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        req.body = {};
      }
    }

    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        res.statusCode = this.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      },
    };

    await handler(req, response);
  });
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-api',
      configureServer(server) {
        mountApi(server, '/api/airtable', airtableHandler);
        mountApi(server, '/api/session', sessionHandler);
        mountApi(server, '/api/enquiry', enquiryHandler);
        mountApi(server, '/api/lead', leadHandler);
      },
    },
  ],
});
