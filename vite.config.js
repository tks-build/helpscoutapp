import react from '@vitejs/plugin-react';
import 'dotenv/config';
import { defineConfig } from 'vite';
import airtableHandler from './api/airtable.js';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-airtable-api',
      configureServer(server) {
        server.middlewares.use('/api/airtable', async (req, res) => {
          const url = new URL(req.url || '', 'http://localhost');
          req.query = Object.fromEntries(url.searchParams.entries());
          req.method = req.method || 'GET';

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

          await airtableHandler(req, response);
        });
      },
    },
  ],
});
