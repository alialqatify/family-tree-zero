/*
# Create family tree tables

Creates the three tables for the family tree Excel importer:
- people: individuals with optional father reference, gender, life status, external flag, phone, photo, family origin.
- marriages: marriage links between a husband and a wife, keyed by a text marriage_id.
- children_link: links a child (person) to a marriage.

No auth / single-tenant app: the dashboard imports data using the anon key, so all
policies are open to anon + authenticated.
*/

CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id text,
  full_name text,
  family_title text,
  gender text,
  father_id uuid,
  is_external boolean,
  life_status text CHECK (life_status IN ('حي','متوفى','شهيد')),
  phone_number text,
  photo_url text,
  family_origin_id text
);

ALTER TABLE people ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_people" ON people;
CREATE POLICY "anon_select_people" ON people
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_people" ON people;
CREATE POLICY "anon_insert_people" ON people
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_people" ON people;
CREATE POLICY "anon_update_people" ON people
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_people" ON people;
CREATE POLICY "anon_delete_people" ON people
  FOR DELETE TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS marriages (
  marriage_id text PRIMARY KEY,
  husband_id uuid,
  wife_id uuid,
  status text
);

ALTER TABLE marriages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_marriages" ON marriages;
CREATE POLICY "anon_select_marriages" ON marriages
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_marriages" ON marriages;
CREATE POLICY "anon_insert_marriages" ON marriages
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_marriages" ON marriages;
CREATE POLICY "anon_update_marriages" ON marriages
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_marriages" ON marriages;
CREATE POLICY "anon_delete_marriages" ON marriages
  FOR DELETE TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS children_link (
  child_id uuid,
  marriage_id text,
  PRIMARY KEY (child_id, marriage_id)
);

ALTER TABLE children_link ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_children_link" ON children_link;
CREATE POLICY "anon_select_children_link" ON children_link
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_children_link" ON children_link;
CREATE POLICY "anon_insert_children_link" ON children_link
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_children_link" ON children_link;
CREATE POLICY "anon_update_children_link" ON children_link
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_children_link" ON children_link;
CREATE POLICY "anon_delete_children_link" ON children_link
  FOR DELETE TO anon, authenticated USING (true);
