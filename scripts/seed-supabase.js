/**
 * Verify / re-seed Supabase test data (tables must already exist).
 *
 * 1) First-time: run scripts/supabase-init.sql in the Supabase SQL Editor
 *    https://supabase.com/dashboard/project/cdsfpivnoqsdmqtkuqyf/sql/new
 * 2) Then: node scripts/seed-supabase.js
 *
 * Optional: set DATABASE_URL=postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres
 * to apply scripts/supabase-init.sql automatically via `pg`.
 */
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const sqlPath = path.join(__dirname, "supabase-init.sql");

async function applyViaPg() {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) return false;
  let pg;
  try {
    pg = require("pg");
  } catch {
    console.log("Install pg to auto-apply SQL: npm install pg");
    return false;
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log("Applied scripts/supabase-init.sql via DATABASE_URL");
    return true;
  } finally {
    await client.end();
  }
}

async function status() {
  const tables = [
    "company_info",
    "sectors",
    "employees",
    "customers",
    "meetings",
    "products",
    "leadership",
    "news",
    "key_facts",
  ];
  const out = {};
  let anyMissing = false;
  for (const t of tables) {
    const { data, error } = await sb.from(t).select("id").limit(1);
    if (error) {
      out[t] = `ERR ${error.message}`;
      anyMissing = true;
    } else {
      const { count } = await sb.from(t).select("*", { count: "exact", head: true });
      out[t] = count ?? (data?.length || 0);
    }
  }
  return { out, anyMissing };
}

async function main() {
  let { out: report, anyMissing } = await status();

  if (anyMissing) {
    console.log("Tables not found yet. Trying DATABASE_URL auto-apply...");
    const applied = await applyViaPg().catch((e) => {
      console.error("pg apply failed:", e.message);
      return false;
    });
    if (!applied) {
      console.log(`
============================================================
Run this SQL once in the Supabase SQL Editor, then re-run:
  node scripts/seed-supabase.js

File:  scripts/supabase-init.sql
Editor: https://supabase.com/dashboard/project/cdsfpivnoqsdmqtkuqyf/sql/new

(The SQL was also copied to your clipboard if you ran npm seed from the agent.)

Or set DATABASE_URL (Project Settings → Database → URI) and re-run.
============================================================
`);
      console.log("Current status:", report);
      process.exit(2);
    }
    ({ out: report, anyMissing } = await status());
  }

  console.log("Supabase seed status:");
  for (const [k, v] of Object.entries(report)) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }

  const { data: meetings, error } = await sb
    .from("meetings")
    .select("id, visitor_name, visitor_company, meeting_time, employees(name)")
    .order("id");
  if (error) {
    console.error("meetings detail:", error.message);
    process.exit(1);
  }
  console.log("\nTest meetings:");
  for (const m of meetings || []) {
    const host = Array.isArray(m.employees) ? m.employees[0]?.name : m.employees?.name;
    console.log(`  #${m.id} ${m.visitor_name} @ ${m.visitor_company} → ${host} (${m.meeting_time})`);
  }
  console.log("\nTry in Geno: \"I have a meeting with Asser Emad, I'm John Miller from Siemens\"");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
