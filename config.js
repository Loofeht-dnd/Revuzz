/* ============================================================
   Revuzz cloud configuration
   Project: qizdndshzwtklxipnsgr
   1. Create a project at https://supabase.com
   2. Run supabase/ALL.sql in the SQL Editor (then verify.sql)
   3. Project Settings -> API: copy the Project URL and the
      "anon / public" key (or the sb_publishable_ key) here.
   4. Never put the service_role / sb_secret_ key in this file.
   ============================================================ */
window.REVUZZ_CLOUD = {
  url: 'https://qizdndshzwtklxipnsgr.supabase.co',

  /* PUBLIC key. This is the legacy "anon / public" JWT (role: anon).
     It is safe in a browser: row-level security is what protects the data.
     An "sb_publishable_..." key works here too.
     A "service_role" JWT or an "sb_secret_..." key must NEVER go here -
     revuzz-cloud.js refuses to start if it sees one. */
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpemRuZHNoend0a2x4aXBuc2dyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxODEwNzAsImV4cCI6MjExMDc1NzA3MH0.jAdy6GjuMbg_4G_HC8cloceIpZP70NAXzLtezAz9ATk',

  /* 'password' is the working mode: student number + password.
     Email-code login needs custom SMTP and is not enabled yet. */
  authMode: 'password'
};
