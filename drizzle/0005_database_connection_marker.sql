-- Owner-controlled singleton used to compare separately authenticated pools.
CREATE SCHEMA db_boundary;
REVOKE ALL ON SCHEMA db_boundary FROM PUBLIC;
CREATE TABLE db_boundary.connection_marker (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO db_boundary.connection_marker(singleton) VALUES (true);
REVOKE ALL ON db_boundary.connection_marker FROM PUBLIC;
