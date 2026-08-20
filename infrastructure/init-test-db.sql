-- Runs once when the Postgres volume is first initialised. POSTGRES_DB gives us
-- the "a04" database; the test suite needs a separate one it can drop/recreate.
CREATE DATABASE a04_test;
