iCoachAndrew Digital Twin — Full Web & API Application (Rings 0, 1, 2, 3)

Overview
Complete web application implementing the Digital Twin Ring Protocol v0.3 and Developer Spec v0.2:
1. User Site (Public Ring 3, Member Ring 2, Executor Ring 1) — served from public/index.html + public/i18n/{en,id}.json.
2. Admin Site (Andrew Ring 0 Only) — served on a separate port/hostname from public/admin.html.
3. Four Physically Separate Knowledge Stores — data/rings/ring{0..3}/docs.json.
4. Full Ring Policy Service, 5-word Shingle Leak Guard, Three Duties & Prompt-Injection Guardrails, and Append-Only Privacy-Safe Audit Log.

Run Locally or on Hostinger
1. Node.js 20+ (Zero external npm dependencies required).
2. Set environment variables:
   - ADMIN_PASSPHRASE (required for Ring 0 login; fails closed if omitted)
   - ANTHROPIC_API_KEY (optional; uses Claude API when set, or extractive fallback for testing)
   - PORT or USER_PORT (default 3000)
   - ADMIN_PORT (default 3001)
3. Start server:
   npm start
   (or: node server.js)
4. Run automated acceptance tests:
   npm test
   (or: node --test test/ring.test.js)
