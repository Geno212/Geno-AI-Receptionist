/**
 * Data access for Geno: Supabase first, db.json offline fallback.
 * Shape matches what system-prompt + tool handlers expect.
 */
const fs = require("fs");
const path = require("path");
const { getSupabase, isConfigured } = require("./supabase");

const dbPath = path.join(__dirname, "..", "db.json");

function loadJsonDB() {
  if (!fs.existsSync(dbPath)) {
    const empty = {
      company_info: {},
      customers: [],
      reservations: [],
      meetings: [],
      counters: { customers: 0, reservations: 0 },
    };
    fs.writeFileSync(dbPath, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function saveJsonDB(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

/** Build company_info object from normalized Supabase tables (see db.sql). */
async function loadCompanyInfoFromSupabase() {
  const sb = getSupabase();
  if (!sb) return null;

  const [
    { data: companyRows, error: companyErr },
    { data: sectors },
    { data: keyFacts },
    { data: news },
    { data: leadership },
    { data: employees },
  ] = await Promise.all([
    sb.from("company_info").select("*").limit(1),
    sb.from("sectors").select("name, description").order("id"),
    sb.from("key_facts").select("category, fact, value, year").order("id"),
    sb.from("news").select("title, description, date, category, amount").order("date", { ascending: false }).limit(10),
    sb.from("leadership").select("name, title, profile").order("order_position"),
    sb
      .from("employees")
      .select("name, email, phone, department, current_title, profile, linkedin, can_schedule_meetings")
      .eq("is_active", true)
      .order("id"),
  ]);

  if (companyErr) {
    console.warn("[db] supabase company_info:", companyErr.message);
    return null;
  }

  const company = companyRows?.[0];
  if (!company) {
    // Tables exist but not seeded yet — empty KB until you seed.
    return {
      name: "El Sewedy Electric",
      description: "",
      headquarters: "",
      contact: {},
      working_hours: {},
      sectors: [],
      key_facts: [],
      recent_news: [],
      leadership: [],
      key_contacts: [],
    };
  }

  return {
    name: company.name,
    description: company.description,
    headquarters: company.headquarters,
    contact: company.contact || {},
    working_hours: company.working_hours || {},
    sectors: (sectors || []).map((s) => s.name),
    key_facts: (keyFacts || []).map((f) => ({
      category: f.category,
      fact: f.fact,
      value: f.value,
      year: f.year,
    })),
    recent_news: (news || []).map((n) => ({
      title: n.title,
      description: n.description,
      date: n.date,
      category: n.category,
      amount: n.amount,
    })),
    leadership: leadership || [],
    key_contacts: (employees || []).map((e) => ({
      name: e.name,
      email: e.email,
      phone: e.phone,
      department: e.department,
      title: e.current_title,
      profile: e.profile,
      linkedin: e.linkedin,
    })),
  };
}

async function getCompanyInfo() {
  if (isConfigured()) {
    const info = await loadCompanyInfoFromSupabase();
    if (info) return info;
  }
  return loadJsonDB().company_info || {};
}

async function listCustomers() {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("customers").select("*").order("id");
    if (!error) return data || [];
    console.warn("[db] listCustomers:", error.message);
  }
  return loadJsonDB().customers || [];
}

async function upsertCustomer({ name, phone, company, interest }) {
  const sb = getSupabase();
  if (sb) {
    const { data: existing } = await sb.from("customers").select("*").eq("phone", phone).maybeSingle();
    if (existing) {
      const patch = {};
      if (name && existing.name !== name) patch.name = name;
      if (company != null && existing.company !== company) patch.company = company;
      if (interest != null && existing.interest !== interest) patch.interest = interest;
      if (Object.keys(patch).length === 0) {
        return { customer: existing, created: false, updated: false };
      }
      const { data, error } = await sb
        .from("customers")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      return { customer: data, created: false, updated: true };
    }
    const { data, error } = await sb
      .from("customers")
      .insert({
        name: name || "Client",
        phone,
        company: company || "",
        interest: interest || "",
      })
      .select()
      .single();
    if (error) throw error;
    return { customer: data, created: true, updated: true };
  }

  // JSON fallback
  const db = loadJsonDB();
  if (!db.customers) db.customers = [];
  let existing = db.customers.find((c) => c.phone === phone);
  if (existing) {
    let updated = false;
    if (name && existing.name !== name) {
      existing.name = name;
      updated = true;
    }
    if (interest && existing.interest !== interest) {
      existing.interest = interest;
      updated = true;
    }
    if (company && existing.company !== company) {
      existing.company = company;
      updated = true;
    }
    if (updated) saveJsonDB(db);
    return { customer: existing, created: false, updated };
  }
  db.counters = db.counters || { customers: 0 };
  db.counters.customers = (db.counters.customers || 0) + 1;
  const lead = {
    id: db.counters.customers,
    name: name || "Client",
    phone,
    company: company || "",
    interest: interest || "",
    created_at: Date.now(),
  };
  db.customers.push(lead);
  saveJsonDB(db);
  return { customer: lead, created: true, updated: true };
}

/**
 * Meetings flattened for fuzzy matching (legacy host_name / host_email fields).
 */
async function listMeetingsForMatch() {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from("meetings")
      .select(
        `
        id,
        visitor_name,
        visitor_phone,
        visitor_company,
        meeting_time,
        topic,
        location,
        status,
        approval_status,
        notes,
        employees (
          id,
          name,
          email,
          phone,
          department,
          current_title
        )
      `
      )
      .order("meeting_time", { ascending: false });
    if (error) {
      console.warn("[db] listMeetings:", error.message);
    } else {
      return (data || []).map((m) => {
        const emp = Array.isArray(m.employees) ? m.employees[0] : m.employees;
        const when = m.meeting_time ? new Date(m.meeting_time) : null;
        const time =
          when && !Number.isNaN(when.getTime())
            ? `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
            : null;
        return {
          id: m.id,
          visitor_name: m.visitor_name,
          visitor_company: m.visitor_company || "",
          visitor_phone: m.visitor_phone,
          host_name: emp?.name || "",
          host_email: emp?.email || "",
          host_company: "El Sewedy Electric",
          department: emp?.department || "",
          time,
          meeting_time: m.meeting_time,
          status: m.status,
          approval_status: m.approval_status,
          topic: m.topic,
          location: m.location,
        };
      });
    }
  }

  return loadJsonDB().meetings || [];
}

module.exports = {
  getCompanyInfo,
  listCustomers,
  upsertCustomer,
  listMeetingsForMatch,
  loadJsonDB,
  saveJsonDB,
  isConfigured,
};
