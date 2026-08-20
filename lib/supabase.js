/**
 * Server-side Supabase client for Express (service role preferred for tools).
 * Falls back to the publishable key when service role is not set.
 */
const { createClient } = require("@supabase/supabase-js");

let cached = null;

function getSupabase() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

function isConfigured() {
  return Boolean(getSupabase());
}

module.exports = { getSupabase, isConfigured };
