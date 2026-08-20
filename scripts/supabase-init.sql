-- Geno test schema + seed for Supabase
-- Run once in: Dashboard → SQL Editor → New query → Run
-- Project: cdsfpivnoqsdmqtkuqyf

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ========== TABLES ==========
CREATE TABLE IF NOT EXISTS company_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  headquarters TEXT,
  contact JSONB,
  working_hours JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sectors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS key_facts (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT,
  year INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date DATE,
  category TEXT,
  amount TEXT,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leadership (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  profile TEXT,
  linkedin TEXT,
  order_position INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  department TEXT,
  current_title TEXT,
  profile TEXT,
  linkedin TEXT,
  work_history JSONB,
  is_active BOOLEAN DEFAULT true,
  can_schedule_meetings BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS affiliated_companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  company TEXT,
  interest TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meetings (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  visitor_customer_id INTEGER REFERENCES customers(id),
  visitor_name TEXT NOT NULL,
  visitor_phone TEXT,
  visitor_company TEXT,
  meeting_time TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  topic TEXT,
  location TEXT DEFAULT 'El Sewedy HQ',
  status TEXT DEFAULT 'scheduled',
  approval_status TEXT DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  subject TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT DEFAULT 'new',
  assigned_to_employee_id INTEGER REFERENCES employees(id),
  priority TEXT DEFAULT 'medium',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  description TEXT,
  specifications JSONB,
  applications TEXT[],
  datasheet_url TEXT,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(is_active);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_meetings_time ON meetings(meeting_time);
CREATE INDEX IF NOT EXISTS idx_meetings_employee ON meetings(employee_id);

-- ========== RESET SEED (safe for test project) ==========
TRUNCATE
  meetings,
  inquiries,
  customers,
  products,
  affiliated_companies,
  employees,
  leadership,
  news,
  key_facts,
  sectors,
  company_info
RESTART IDENTITY CASCADE;

-- ========== SEED ==========
INSERT INTO company_info (name, description, headquarters, contact, working_hours) VALUES (
  'El Sewedy Electric',
  'El Sewedy Electric is a global leader in integrated energy solutions, infrastructure, and digital innovation, founded in 1938.',
  'Cairo, Egypt',
  '{"phone": "+20 2 27599700", "email": "info@elsewedy.com", "website": "https://www.elsewedyelectric.com", "address": "Plot 27, 1st District, 5th Settlement, New Cairo, Egypt"}'::jsonb,
  '{"standard": "09:00 - 17:00", "days": "Sunday - Thursday"}'::jsonb
);

INSERT INTO sectors (name) VALUES
  ('Wire, Cable & Accessories (Power, Special, Telecom)'),
  ('Electrical Products (Transformers, Motors, Insulators)'),
  ('Engineering & Construction (Turnkey Power/Infra Projects)'),
  ('Digital Solutions (Smart Meters, Data Centers, Automation)'),
  ('Infrastructure Investments (Green Energy, Industrial Cities)');

INSERT INTO key_facts (category, fact, value, year) VALUES
  ('revenue', 'Revenues', '$5.13 Billion+', 2024),
  ('employees', 'Employees', '19,000+', NULL),
  ('presence', 'Presence', '110+ Countries, 34+ Production Facilities', NULL),
  ('stock', 'Listed on EGX', 'Ticker: SWDY', NULL);

INSERT INTO news (title, date, category, amount) VALUES
  ('Signed EGP 20B credit facility with Emirates NBD', '2025-10-01', 'financing', 'EGP 20B'),
  ('Acquired 60% of Thomassen Service', '2025-05-01', 'acquisition', '60%'),
  ('Partnered with Morshedy Group for EV charging infrastructure', '2025-05-01', 'partnership', NULL),
  ('Building $400M Industrial City in Tanzania', '2025-01-01', 'expansion', '$400M');

INSERT INTO leadership (name, title, profile, order_position) VALUES
  ('Sadek Ahmed Sadek El Sewedy', 'Non-Executive Chairman', 'Senior member of the group since the company''s early growth.', 1),
  ('Ahmed Ahmed Elsewedy', 'CEO & Managing Director', NULL, 2),
  ('Abdelrahman Ahmed Elsewedy', 'Group Chief Operations & Strategy Officer', 'Executive Board Member supervising operations and global expansion.', 3),
  ('Mohamed Ahmed Sadek Elsewedy', 'Vice President & CEO Wires & Cables', 'Leads the core Wires & Cables business.', 4);

INSERT INTO employees (name, email, phone, department, current_title, profile, linkedin, work_history, can_schedule_meetings) VALUES
  (
    'Asser Emad',
    'asser.emad@elsewedy.com',
    '+201000000001',
    'Administration & Facilities',
    'Group Director of Administration',
    'Group Director of Administration & Facilities at El Sewedy Electric. Oversees facilities and security across multiple countries.',
    'https://www.linkedin.com/in/asser-emad-06a92025',
    '[{"title":"Group Director of Administration","company":"El Sewedy Electric HQ","duration":"Nov 2015 - Present"}]'::jsonb,
    true
  ),
  (
    'Mohamed Zamzam',
    'mohamed.zamzam@elsewedy.com',
    '+201000000002',
    'Executive Office',
    'Former Executive Director to CEO',
    'Long-time executive aide to the CEO office; now General Manager at Arab Security & Facility Management.',
    'https://www.linkedin.com/in/mohamed-z-19927b',
    '[{"title":"Executive Director to CEO","company":"Elsewedy Electric","duration":"Jan 1997 - Feb 2025"}]'::jsonb,
    true
  ),
  (
    'Ahmed Sadek',
    'ahmed.sadek@elsewedy.com',
    '+201000000003',
    'AI & Data Science',
    'AI Department Head',
    'Leading AI and Data Science initiatives at El Sewedy Electric.',
    NULL,
    '[]'::jsonb,
    true
  );

INSERT INTO affiliated_companies (name, category) VALUES
  ('Elsewedy Electric', 'main'),
  ('Breadfast', 'ventures'),
  ('Magma Sportwear', 'ventures');

INSERT INTO products (name, category, subcategory, description, applications) VALUES
  ('Power Cables', 'cables', 'power', 'High and medium voltage power transmission cables', ARRAY['Power transmission', 'Grid infrastructure']),
  ('Smart Meters', 'digital', 'metering', 'Digital electricity meters with remote monitoring', ARRAY['Smart grid', 'Utilities']),
  ('Power Transformers', 'transformers', 'power', 'Large scale power transformers for grid applications', ARRAY['Power substations']);

-- Test customers + meetings (for Geno check_meeting / save_lead)
INSERT INTO customers (name, phone, email, company, interest) VALUES
  ('John Miller', '+201111111111', 'john.miller@siemens.test', 'Siemens', 'Cables'),
  ('Sara Hassan', '+201222222222', 'sara@nile.test', 'Nile Contracting', 'Smart meters');

INSERT INTO meetings (
  employee_id, visitor_customer_id, visitor_name, visitor_phone, visitor_company,
  meeting_time, topic, location, status, approval_status
) VALUES
  (
    1, 1, 'John Miller', '+201111111111', 'Siemens',
    (date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') + INTERVAL '14 hours') AT TIME ZONE 'Africa/Cairo',
    'Cable supply discussion', 'El Sewedy HQ', 'scheduled', 'pending'
  ),
  (
    3, 2, 'Sara Hassan', '+201222222222', 'Nile Contracting',
    (date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') + INTERVAL '11 hours') AT TIME ZONE 'Africa/Cairo',
    'Smart meter pilot', 'El Sewedy HQ', 'scheduled', 'pending'
  ),
  (
    2, NULL, 'Omar Farouk', '+201333333333', 'Orascom',
    (date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') + INTERVAL '16 hours') AT TIME ZONE 'Africa/Cairo',
    'Facilities visit', 'El Sewedy HQ', 'scheduled', 'pending'
  );

-- Expose tables to API roles
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT INSERT, UPDATE ON customers, meetings, inquiries TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
