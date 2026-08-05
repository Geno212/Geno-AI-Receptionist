-- ============================================
-- UPDATED SCHEMA WITH PROPER RELATIONSHIPS
-- ============================================

-- ============================================
-- 1. COMPANY INFORMATION
-- ============================================
CREATE TABLE company_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  headquarters TEXT,
  contact JSONB,
  working_hours JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. BUSINESS SECTORS
-- ============================================
CREATE TABLE sectors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 3. KEY FACTS
-- ============================================
CREATE TABLE key_facts (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT,
  year INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 4. RECENT NEWS
-- ============================================
CREATE TABLE news (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date DATE,
  category TEXT,
  amount TEXT,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_news_date ON news(date DESC);
CREATE INDEX idx_news_category ON news(category);

-- ============================================
-- 5. LEADERSHIP TEAM
-- ============================================
CREATE TABLE leadership (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  profile TEXT,
  linkedin TEXT,
  order_position INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 6. EMPLOYEES (formerly contacts - people who work at El Sewedy)
-- ============================================
CREATE TABLE employees (
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

-- Indexes for employee search and fuzzy matching
CREATE INDEX idx_employees_name ON employees USING gin(to_tsvector('english', name));
CREATE INDEX idx_employees_department ON employees(department);
CREATE INDEX idx_employees_active ON employees(is_active);
CREATE INDEX idx_employees_email ON employees(email);

-- ============================================
-- 7. AFFILIATED COMPANIES
-- ============================================
CREATE TABLE affiliated_companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 8. CUSTOMERS (External people calling/visiting)
-- ============================================
CREATE TABLE customers (
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

CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_company ON customers(company);
CREATE INDEX idx_customers_created ON customers(created_at DESC);

-- ============================================
-- 9. MEETINGS (visitors meeting WITH employees)
-- ============================================
CREATE TABLE meetings (
  id SERIAL PRIMARY KEY,
  
  -- Employee (host) - references employees table
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  
  -- Visitor (external person) - can optionally reference customers table
  visitor_customer_id INTEGER REFERENCES customers(id),
  visitor_name TEXT NOT NULL,
  visitor_phone TEXT,
  visitor_company TEXT,
  
  -- Meeting details
  meeting_time TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  topic TEXT,
  location TEXT DEFAULT 'El Sewedy HQ',
  
  -- Status tracking
  status TEXT DEFAULT 'scheduled', -- scheduled, confirmed, completed, cancelled
  approval_status TEXT DEFAULT 'pending', -- pending, approved, rejected
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for meeting queries
CREATE INDEX idx_meetings_employee ON meetings(employee_id);
CREATE INDEX idx_meetings_visitor_customer ON meetings(visitor_customer_id);
CREATE INDEX idx_meetings_time ON meetings(meeting_time);
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE INDEX idx_meetings_approval ON meetings(approval_status);

-- ============================================
-- 10. INQUIRIES
-- ============================================
CREATE TABLE inquiries (
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

CREATE INDEX idx_inquiries_customer ON inquiries(customer_id);
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_assigned ON inquiries(assigned_to_employee_id);
CREATE INDEX idx_inquiries_created ON inquiries(created_at DESC);

-- ============================================
-- 11. PRODUCTS CATALOG
-- ============================================
CREATE TABLE products (
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

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_active ON products(is_active);
CREATE INDEX idx_products_search ON products USING gin(to_tsvector('english', name || ' ' || description));

-- ============================================
-- INITIALIZE DATA
-- ============================================

-- Insert company info
INSERT INTO company_info (name, description, headquarters, contact, working_hours) VALUES (
  'El Sewedy Electric',
  'El Sewedy Electric is a global leader in integrated energy solutions, infrastructure, and digital innovation, founded in 1938.',
  'Cairo, Egypt',
  '{"phone": "+20 2 27599700", "email": "info@elsewedy.com", "website": "https://www.elsewedyelectric.com", "address": "Plot 27, 1st District, 5th Settlement, New Cairo, Egypt"}'::jsonb,
  '{"standard": "09:00 - 17:00", "days": "Sunday - Thursday"}'::jsonb
);

-- Insert sectors
INSERT INTO sectors (name) VALUES
  ('Wire, Cable & Accessories (Power, Special, Telecom)'),
  ('Electrical Products (Transformers, Motors, Insulators)'),
  ('Engineering & Construction (Turnkey Power/Infra Projects)'),
  ('Digital Solutions (Smart Meters, Data Centers, Automation)'),
  ('Infrastructure Investments (Green Energy, Industrial Cities)');

-- Insert key facts
INSERT INTO key_facts (category, fact, value, year) VALUES
  ('revenue', 'Revenues', '$5.13 Billion+', 2024),
  ('employees', 'Employees', '19,000+', NULL),
  ('presence', 'Presence', '110+ Countries, 34+ Production Facilities', NULL),
  ('stock', 'Listed on EGX', 'Ticker: SWDY', NULL);

-- Insert recent news
INSERT INTO news (title, date, category, amount) VALUES
  ('Signed EGP 20B credit facility with Emirates NBD', '2025-10-01', 'financing', 'EGP 20B'),
  ('Acquired 60% of Thomassen Service', '2025-05-01', 'acquisition', '60%'),
  ('Partnered with Morshedy Group for EV charging infrastructure', '2025-05-01', 'partnership', NULL),
  ('Building $400M Industrial City in Tanzania', '2025-01-01', 'expansion', '$400M'),
  ('Signed MOU with Iraq Development Fund for non-oil investments', '2024-10-01', 'partnership', NULL);

-- Insert leadership
INSERT INTO leadership (name, title, profile, order_position) VALUES
  ('Sadek Ahmed Sadek El Sewedy', 'Non-Executive Chairman', 'Senior member of the group. Under his leadership, the company grew from a small local business started in 1938 into a global multinational active in energy, infrastructure, and manufacturing.', 1),
  ('Ahmed Ahmed Elsewedy', 'CEO & Managing Director', NULL, 2),
  ('Abdelrahman Ahmed Elsewedy', 'Group Chief Operations & Strategy Officer', 'Executive Board Member supervising operations, strategy, and global expansion. Founder & Chairman of Kiyaa Capital. Leads digital infrastructure, telecom-cables, and steel business units.', 3),
  ('Mohamed Ahmed Sadek Elsewedy', 'Vice President & CEO Wires & Cables', 'Leads the core Wires & Cables business. Transformed the company into a global integrated energy-solutions provider. Co-founder of Breadfast, Magma Sportwear, and Kings Polo Club.', 4);

-- Insert employees
INSERT INTO employees (name, email, phone, department, current_title, profile, linkedin, work_history, can_schedule_meetings) VALUES
  (
    'Asser Emad',
    'asser.emad@elsewedy.com',
    '+20 xxx',
    'Administration & Facilities',
    'Group Director of Administration',
    'Group Director of Administration & Facilities management at El Sewedy Electric. Experienced Director Of Administration and Facilities working in Egypt, United Arab Emirates, Iraq, Tanzania and other 5 countries. In charge of all facilities and life support services in addition to security.',
    'https://www.linkedin.com/in/asser-emad-06a92025',
    '[
      {"title": "Group Director of Administration", "company": "El Sewedy Electric HQ", "duration": "Nov 2015 - Present", "description": "In charge of El Sewedy Group administration, facility and security sectors, operating in 16 countries."},
      {"title": "Administration & Main Head Office Building Manager", "company": "El Sewedy Electric", "duration": "Mar 2010 - Oct 2015", "description": "Managing the administration and governmental relations, housekeeping, security, stores, transportation, cafeteria, maintenance, purchasing, and investigations."}
    ]'::jsonb,
    true
  ),
  (
    'Mohamed Zamzam',
    'mohamed.zamzam@elsewedy.com',
    '+20 xxx',
    'Executive Office',
    'Former Executive Director to CEO',
    'Previously Executive Director - Senior Executive Asst. - CEO at Elsewedy Electric (Jan 1997 - Feb 2025). Now General Manager at Arab Security & Facility Management.',
    'https://www.linkedin.com/in/mohamed-z-19927b',
    '[
      {"title": "General Manager", "company": "Arab Security And Facility Management", "duration": "Feb 2025 - Present", "description": "General Manager role."},
      {"title": "Executive Director - Senior Executive Asst. and Office Manager to CEO Ahmed Elsewedy office", "company": "Elsewedy Electric", "duration": "Jan 1997 - Feb 2025", "description": "Served as Executive Director and Senior Executive Assistant to the CEO for over 28 years."}
    ]'::jsonb,
    true
  ),
  (
    'Ahmed Sadek',
    'ahmed.sadek@elsewedy.com',
    '+20 xxx',
    'AI & Data Science',
    'AI Department Head',
    'Leading AI and Data Science initiatives at El Sewedy Electric.',
    NULL,
    '[]'::jsonb,
    true
  );

-- Insert affiliated companies
INSERT INTO affiliated_companies (name, category) VALUES
  ('Elsewedy Electric', 'main'),
  ('Production Arms: Cables & wires, electrical equipment, lighting, transformers', 'production'),
  ('Building Materials: Cement, ready-mix concrete, chemical industries, steel fabrication', 'building_materials'),
  ('Real Estate & Development', 'real_estate'),
  ('Digital Infrastructure & Supply Chain Ventures', 'digital'),
  ('Breadfast', 'ventures'),
  ('Magma Sportwear', 'ventures'),
  ('Kings Polo Club', 'ventures');

-- Insert sample products
INSERT INTO products (name, category, subcategory, description, applications) VALUES
  ('Power Cables', 'cables', 'power', 'High voltage and medium voltage power transmission cables', ARRAY['Power transmission', 'Grid infrastructure', 'Industrial plants']),
  ('Telecom Cables', 'cables', 'telecom', 'Fiber optic and copper telecommunication cables', ARRAY['Telecommunications', '5G networks', 'Data centers']),
  ('Special Cables', 'cables', 'special', 'Specialized cables for specific industrial applications', ARRAY['Oil & gas', 'Marine', 'Mining']),
  ('Power Transformers', 'transformers', 'power', 'Large scale power transformers for grid applications', ARRAY['Power substations', 'Grid distribution']),
  ('Distribution Transformers', 'transformers', 'distribution', 'Medium voltage distribution transformers', ARRAY['Commercial buildings', 'Industrial facilities']),
  ('Smart Meters', 'digital', 'metering', 'Digital electricity meters with remote monitoring', ARRAY['Smart grid', 'Energy management', 'Utilities']);

-- ============================================
-- VIEWS FOR EASY QUERYING
-- ============================================

-- View: Meetings with full employee and visitor details
CREATE VIEW meeting_details AS
SELECT 
  m.id,
  m.meeting_time,
  m.duration_minutes,
  m.topic,
  m.location,
  m.status,
  m.approval_status,
  -- Employee details
  e.id AS employee_id,
  e.name AS employee_name,
  e.email AS employee_email,
  e.department AS employee_department,
  e.current_title AS employee_title,
  -- Visitor details
  m.visitor_name,
  m.visitor_phone,
  m.visitor_company,
  c.id AS visitor_customer_id,
  c.email AS visitor_email,
  c.interest AS visitor_interest,
  m.created_at
FROM meetings m
INNER JOIN employees e ON m.employee_id = e.id
LEFT JOIN customers c ON m.visitor_customer_id = c.id;

-- View: Upcoming meetings with full details
CREATE VIEW upcoming_meetings AS
SELECT *
FROM meeting_details
WHERE meeting_time >= NOW()
  AND status IN ('scheduled', 'confirmed')
ORDER BY meeting_time;

-- View: Recent inquiries with customer and assigned employee
CREATE VIEW recent_inquiries AS
SELECT 
  i.id,
  i.subject,
  i.category,
  i.status,
  i.priority,
  c.name AS customer_name,
  c.phone AS customer_phone,
  c.company AS customer_company,
  e.name AS assigned_to_name,
  e.email AS assigned_to_email,
  i.created_at
FROM inquiries i
LEFT JOIN customers c ON i.customer_id = c.id
LEFT JOIN employees e ON i.assigned_to_employee_id = e.id
ORDER BY i.created_at DESC;

-- View: Customer activity summary
CREATE VIEW customer_activity AS
SELECT 
  c.id,
  c.name,
  c.phone,
  c.company,
  c.interest,
  COUNT(DISTINCT i.id) AS inquiry_count,
  COUNT(DISTINCT m.id) AS meeting_count,
  MAX(i.created_at) AS last_inquiry_date,
  MAX(m.created_at) AS last_meeting_date,
  c.created_at AS first_contact_date
FROM customers c
LEFT JOIN inquiries i ON c.id = i.customer_id
LEFT JOIN meetings m ON c.id = m.visitor_customer_id
GROUP BY c.id;

-- ============================================
-- FUNCTIONS FOR AI WITH FUZZY MATCHING
-- ============================================

-- Function: Fuzzy match employee by name (returns full employee details)
CREATE OR REPLACE FUNCTION find_employee_by_name(search_name TEXT)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  email TEXT,
  phone TEXT,
  department TEXT,
  current_title TEXT,
  profile TEXT,
  linkedin TEXT,
  can_schedule_meetings BOOLEAN,
  similarity_score REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    e.id,
    e.name,
    e.email,
    e.phone,
    e.department,
    e.current_title,
    e.profile,
    e.linkedin,
    e.can_schedule_meetings,
    similarity(e.name, search_name) AS similarity_score
  FROM employees e
  WHERE 
    e.is_active = true
    AND similarity(e.name, search_name) > 0.3  -- Fuzzy match threshold
  ORDER BY similarity_score DESC
  LIMIT 5;
END;
$$ LANGUAGE plpgsql;

-- Enable pg_trgm extension for similarity function
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Function: Verify and get meeting details with employee
CREATE OR REPLACE FUNCTION get_meeting_with_employee(
  p_visitor_name TEXT,
  p_employee_name TEXT,
  p_time_range_hours INTEGER DEFAULT 24
)
RETURNS TABLE (
  meeting_id INTEGER,
  employee_id INTEGER,
  employee_name TEXT,
  employee_email TEXT,
  employee_department TEXT,
  employee_title TEXT,
  visitor_name TEXT,
  visitor_company TEXT,
  meeting_time TIMESTAMPTZ,
  status TEXT,
  approval_status TEXT,
  topic TEXT,
  location TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id AS meeting_id,
    e.id AS employee_id,
    e.name AS employee_name,
    e.email AS employee_email,
    e.department AS employee_department,
    e.current_title AS employee_title,
    m.visitor_name,
    m.visitor_company,
    m.meeting_time,
    m.status,
    m.approval_status,
    m.topic,
    m.location
  FROM meetings m
  INNER JOIN employees e ON m.employee_id = e.id
  WHERE 
    similarity(m.visitor_name, p_visitor_name) > 0.5
    AND similarity(e.name, p_employee_name) > 0.5
    AND m.meeting_time BETWEEN NOW() - INTERVAL '1 hour' AND NOW() + (p_time_range_hours || ' hours')::INTERVAL
    AND m.status IN ('scheduled', 'confirmed')
  ORDER BY m.meeting_time
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function: Create meeting with employee (ensures employee exists)
CREATE OR REPLACE FUNCTION create_meeting_with_employee(
  p_employee_name TEXT,
  p_visitor_name TEXT,
  p_visitor_phone TEXT,
  p_visitor_company TEXT,
  p_meeting_time TIMESTAMPTZ,
  p_topic TEXT DEFAULT NULL
)
RETURNS TABLE (
  success BOOLEAN,
  meeting_id INTEGER,
  employee_found TEXT,
  message TEXT
) AS $$
DECLARE
  v_employee_id INTEGER;
  v_employee_name TEXT;
  v_new_meeting_id INTEGER;
BEGIN
  -- Find the best matching employee
  SELECT e.id, e.name
  INTO v_employee_id, v_employee_name
  FROM employees e
  WHERE e.is_active = true AND e.can_schedule_meetings = true
  ORDER BY similarity(e.name, p_employee_name) DESC
  LIMIT 1;
  
  IF v_employee_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::INTEGER, NULL::TEXT, 'Employee not found: ' || p_employee_name;
    RETURN;
  END IF;
  
  -- Create the meeting
  INSERT INTO meetings (
    employee_id,
    visitor_name,
    visitor_phone,
    visitor_company,
    meeting_time,
    topic,
    status,
    approval_status
  ) VALUES (
    v_employee_id,
    p_visitor_name,
    p_visitor_phone,
    p_visitor_company,
    p_meeting_time,
    p_topic,
    'scheduled',
    'pending'
  )
  RETURNING id INTO v_new_meeting_id;
  
  RETURN QUERY SELECT 
    true, 
    v_new_meeting_id, 
    v_employee_name,
    'Meeting scheduled successfully with ' || v_employee_name;
END;
$$ LANGUAGE plpgsql;

-- Function: Get employee availability (count meetings for employee today)
CREATE OR REPLACE FUNCTION get_employee_meeting_count(p_employee_name TEXT, p_date DATE DEFAULT CURRENT_DATE)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
  v_employee_id INTEGER;
BEGIN
  -- Find employee by fuzzy match
  SELECT id INTO v_employee_id
  FROM employees
  WHERE is_active = true
  ORDER BY similarity(name, p_employee_name) DESC
  LIMIT 1;
  
  IF v_employee_id IS NULL THEN
    RETURN -1; -- Employee not found
  END IF;
  
  SELECT COUNT(*)
  INTO v_count
  FROM meetings
  WHERE employee_id = v_employee_id
    AND DATE(meeting_time) = p_date
    AND status IN ('scheduled', 'confirmed');
  
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Function: Get recent news
CREATE OR REPLACE FUNCTION get_recent_news(limit_count INTEGER DEFAULT 5)
RETURNS TABLE (
  id INTEGER,
  title TEXT,
  date DATE,
  category TEXT,
  amount TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT n.id, n.title, n.date, n.category, n.amount
  FROM news n
  ORDER BY n.date DESC NULLS LAST, n.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Function: Search products
CREATE OR REPLACE FUNCTION search_products(search_term TEXT)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  category TEXT,
  description TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, p.name, p.category, p.description
  FROM products p
  WHERE p.is_active = true
    AND (
      p.name ILIKE '%' || search_term || '%'
      OR p.category ILIKE '%' || search_term || '%'
      OR p.description ILIKE '%' || search_term || '%'
    )
  LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- Function: Today's statistics
CREATE OR REPLACE FUNCTION get_todays_stats()
RETURNS TABLE (
  total_meetings INTEGER,
  pending_approvals INTEGER,
  new_customers INTEGER,
  new_inquiries INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    (SELECT COUNT(*)::INTEGER FROM meetings WHERE DATE(meeting_time) = CURRENT_DATE)::INTEGER,
    (SELECT COUNT(*)::INTEGER FROM meetings WHERE DATE(meeting_time) = CURRENT_DATE AND approval_status = 'pending')::INTEGER,
    (SELECT COUNT(*)::INTEGER FROM customers WHERE DATE(created_at) = CURRENT_DATE)::INTEGER,
    (SELECT COUNT(*)::INTEGER FROM inquiries WHERE DATE(created_at) = CURRENT_DATE)::INTEGER;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access customers" ON customers FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access meetings" ON meetings FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access inquiries" ON inquiries FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access employees" ON employees FOR ALL TO service_role USING (true);